<?php
/**
 * Issue #894 Wave 6 — Torob order and action attribution, served by the store.
 *
 * Torob refers a shopper with `?torob_clid=…`, then polls the store for the purchases
 * that came from that click (`torob/Torob-Sync` → `order_tracking_api.md`,
 * `action_tracking_api.md`). Two consequences decide everything in this file:
 *
 *  1. **The store answers, not the accounting platform.** The endpoint Torob calls is
 *     the store's own origin, under a path that must end in `/torob/v1/orders` (or
 *     `/torob/v1/actions`); orders live in WooCommerce, so the answer has to be built
 *     here.
 *  2. **It is off until the merchant says otherwise.** The documents' §3.1 is explicit:
 *     not enabled by default per shop, switchable at any time, and `403` when off. So
 *     the switches below default to `false` and the guard runs **after** the token and
 *     **before** any query — a disabled store answers 403 without touching an order.
 *
 * Everything that can be decided without WordPress is a pure static function so
 * `wordpress-plugin/tests/connector-torob-attribution.php` can pin it under plain
 * `php`: token verification, parameter parsing, record shaping and the 403 gate.
 *
 * What is deliberately *not* invented here: an action feed. The platform has no
 * action events of its own, so `/torob/v1/actions` answers an honest empty list and
 * a site that does track actions supplies them through the
 * `pos_connector_torob_actions` filter. A made-up record would be worse than none:
 * Torob bills against these.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class POS_Connector_Torob {

	/** Per-channel switches. Absent means off — never a default-on. */
	const OPTION_ORDERS  = 'pos_connector_torob_orders';
	const OPTION_ACTIONS = 'pos_connector_torob_actions';

	const CLID_QUERY  = 'torob_clid';
	const CLID_COOKIE = 'torob_clid';
	const CLID_META   = '_torob_clid';

	/** The attribution window the document defines: 7 days from the click. */
	const CLID_TTL = 604800;

	/** The document's ceiling for one poll. */
	const MAX_LIMIT = 1000;

	/** Torob's published verification key (`order_tracking_api.md` §3.2). */
	const PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAt6Mu4T0pBORY11W+QeM35UsmLO3vsf+6yKpFDEImFk0=\n-----END PUBLIC KEY-----";

	/** The only token version the guide defines. */
	const TOKEN_VERSION = '1';

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
		add_action( 'init', array( __CLASS__, 'capture_clid' ), 5 );
		add_action( 'woocommerce_checkout_create_order', array( __CLASS__, 'attach_clid_to_order' ), 10, 1 );
	}

	// ---------------------------------------------------------------------
	// The switches
	// ---------------------------------------------------------------------

	/**
	 * Is one channel on? `true` only for an explicit `1`.
	 *
	 * A truthy-string comparison here would make any leftover option value — an old
	 * version's `'on'`, a filter's array — count as consent to share a store's orders,
	 * which is exactly the thing the documents say must be a deliberate act.
	 */
	public static function is_enabled( $channel ) {
		$option = self::option_name( $channel );
		if ( null === $option ) {
			return false;
		}
		return '1' === (string) get_option( $option, '0' );
	}

	public static function set_enabled( $channel, $enabled ) {
		$option = self::option_name( $channel );
		if ( null === $option ) {
			return false;
		}
		return (bool) update_option( $option, $enabled ? '1' : '0', false );
	}

	private static function option_name( $channel ) {
		if ( 'orders' === $channel ) {
			return self::OPTION_ORDERS;
		}
		if ( 'actions' === $channel ) {
			return self::OPTION_ACTIONS;
		}
		return null;
	}

	/**
	 * The 403 the documents require, or `null` when this channel may answer.
	 *
	 * Deliberately a status and a body rather than a boolean: **every** caller has to
	 * send the refusal, not merely decide against sending data.
	 */
	public static function guard( $channel ) {
		if ( self::is_enabled( $channel ) ) {
			return null;
		}
		return array(
			'status' => 403,
			'body'   => array(
				'success' => false,
				'error'   => 'access_disabled',
			),
		);
	}

	// ---------------------------------------------------------------------
	// Tokens
	// ---------------------------------------------------------------------

	/**
	 * Verify `X-Torob-Token` the way the guide's own samples do.
	 *
	 * `alg` must be EdDSA — an `alg: none` token is refused before the signature is
	 * even looked at. `aud` must name this store, which is what stops a token minted
	 * for one partner from being replayed at another. `exp`/`nbf` are checked with
	 * the same one-second granularity the token carries; a caller may pass `$now`.
	 *
	 * @param array        $headers  Lower-cased header name => value.
	 * @param string|array $hosts    Hosts this site answers on (`home_url()` host, and
	 *                               the request's `Host`). Any one match is enough.
	 * @param int|null     $now      Unix seconds; defaults to the current time.
	 * @return array{ok:bool,reason?:string,claims?:array}
	 */
	public static function verify_token( $headers, $hosts, $now = null ) {
		$headers = is_array( $headers ) ? array_change_key_case( $headers, CASE_LOWER ) : array();
		$token   = isset( $headers['x-torob-token'] ) ? trim( (string) $headers['x-torob-token'] ) : '';
		if ( '' === $token ) {
			return self::token_failure( 'missing_token' );
		}

		$version = isset( $headers['x-torob-token-version'] ) ? trim( (string) $headers['x-torob-token-version'] ) : '';
		if ( '' === $version ) {
			return self::token_failure( 'missing_token_version' );
		}
		if ( self::TOKEN_VERSION !== $version ) {
			return self::token_failure( 'unsupported_token_version' );
		}

		$parts = explode( '.', $token );
		if ( 3 !== count( $parts ) ) {
			return self::token_failure( 'invalid_token' );
		}

		$header = self::decode_json( $parts[0] );
		if ( null === $header ) {
			return self::token_failure( 'invalid_token' );
		}
		$alg = isset( $header['alg'] ) ? (string) $header['alg'] : '';
		if ( 'EdDSA' !== $alg ) {
			return self::token_failure( 'wrong_algorithm' );
		}

		$claims = self::decode_json( $parts[1] );
		if ( null === $claims ) {
			return self::token_failure( 'invalid_token' );
		}

		$signature = self::base64url_decode( $parts[2] );
		$signed    = $parts[0] . '.' . $parts[1];
		if ( ! self::signature_is_valid( $signed, $signature ) ) {
			return self::token_failure( 'invalid_token' );
		}

		$now = null === $now ? time() : (int) $now;
		if ( isset( $claims['exp'] ) && $now >= (int) $claims['exp'] ) {
			return self::token_failure( 'expired' );
		}
		if ( isset( $claims['nbf'] ) && $now < (int) $claims['nbf'] ) {
			return self::token_failure( 'not_yet_valid' );
		}

		if ( ! self::audience_matches( isset( $claims['aud'] ) ? $claims['aud'] : null, $hosts ) ) {
			return self::token_failure( 'audience_mismatch' );
		}

		return array(
			'ok'     => true,
			'claims' => $claims,
		);
	}

	private static function token_failure( $reason ) {
		return array(
			'ok'     => false,
			'reason' => $reason,
		);
	}

	private static function signature_is_valid( $signed, $signature ) {
		if ( '' === $signature || ! function_exists( 'sodium_crypto_sign_verify_detached' ) ) {
			return false;
		}
		$key = self::raw_public_key();
		if ( '' === $key ) {
			return false;
		}
		try {
			return (bool) sodium_crypto_sign_verify_detached( $signature, $signed, $key );
		} catch ( Throwable $error ) {
			return false;
		}
	}

	/**
	 * The 32 raw bytes inside the SPKI PEM Torob publishes.
	 *
	 * A PEM block is base64 of a small DER wrapper whose tail **is** the Ed25519 key;
	 * the last 32 bytes are that key. Filterable so a rotation needs no release.
	 */
	private static function raw_public_key() {
		$pem = (string) apply_filters( 'pos_connector_torob_public_key', self::PUBLIC_KEY_PEM );
		$body = preg_replace( '/-----[^-]+-----/', '', $pem );
		$der  = base64_decode( preg_replace( '/\s+/', '', (string) $body ), true );
		if ( false === $der || strlen( $der ) < 32 ) {
			return '';
		}
		return substr( $der, -32 );
	}

	/**
	 * `aud` must name one of this site's hosts, case- and trailing-dot-insensitively.
	 *
	 * The guide allows a port in `aud` (`api.example.com:8080`), and it is the one
	 * difference worth tolerating: a store behind a non-standard port is still the
	 * same store. The comparison is otherwise exact, which is the point of `aud`.
	 */
	private static function audience_matches( $audience, $hosts ) {
		$expected = array();
		foreach ( (array) $hosts as $host ) {
			$normalized = self::normalize_host( $host );
			if ( '' !== $normalized ) {
				$expected[] = $normalized;
			}
		}
		$candidates = array();
		foreach ( (array) $audience as $value ) {
			$candidates[] = self::normalize_host( $value );
		}
		foreach ( $candidates as $candidate ) {
			if ( '' !== $candidate && in_array( $candidate, $expected, true ) ) {
				return true;
			}
			// The bare host, when the token carries a port and this site's record does not.
			$bare = preg_replace( '/:\d+$/', '', $candidate );
			if ( $bare !== $candidate && '' !== $bare && in_array( $bare, $expected, true ) ) {
				return true;
			}
		}
		return false;
	}

	public static function normalize_host( $value ) {
		$value = strtolower( trim( (string) $value ) );
		$value = rtrim( $value, '.' );
		return $value;
	}

	private static function decode_json( $segment ) {
		$raw = self::base64url_decode( $segment );
		if ( '' === $raw ) {
			return null;
		}
		$decoded = json_decode( $raw, true );
		return is_array( $decoded ) ? $decoded : null;
	}

	private static function base64url_decode( $value ) {
		$padded = strtr( (string) $value, '-_', '+/' );
		$remainder = strlen( $padded ) % 4;
		if ( 0 !== $remainder ) {
			$padded .= str_repeat( '=', 4 - $remainder );
		}
		$decoded = base64_decode( $padded, true );
		return false === $decoded ? '' : $decoded;
	}

	// ---------------------------------------------------------------------
	// Request parameters
	// ---------------------------------------------------------------------

	/**
	 * Validate the two parameters both documents require.
	 *
	 * `limit` is required and bounded at 1000 by the documents; a caller asking for
	 * 5000 gets 400 rather than a silently trimmed 1000, because the returned window
	 * would otherwise look complete when it is not. `*_gt` must be ISO 8601 in UTC
	 * with the `Z` suffix the documents specify.
	 *
	 * @return array{ok:bool,error?:string,since?:string,limit?:int}
	 */
	public static function parse_params( $query, $channel ) {
		$query = is_array( $query ) ? $query : array();
		$since_key = 'orders' === $channel ? 'purchase_timestamp_gt' : 'timestamp_gt';

		$since = isset( $query[ $since_key ] ) ? trim( (string) $query[ $since_key ] ) : '';
		if ( '' === $since ) {
			return array(
				'ok'    => false,
				'error' => 'missing_' . $since_key,
			);
		}
		if ( ! self::is_iso_utc( $since ) ) {
			return array(
				'ok'    => false,
				'error' => 'invalid_' . $since_key,
			);
		}

		if ( ! isset( $query['limit'] ) || '' === trim( (string) $query['limit'] ) ) {
			return array(
				'ok'    => false,
				'error' => 'missing_limit',
			);
		}
		$raw   = trim( (string) $query['limit'] );
		$limit = ctype_digit( $raw ) ? (int) $raw : 0;
		if ( $limit < 1 || $limit > self::MAX_LIMIT ) {
			return array(
				'ok'    => false,
				'error' => 'invalid_limit',
			);
		}

		return array(
			'ok'    => true,
			'since' => $since,
			'limit' => $limit,
		);
	}

	/** `2025-09-21T10:00:00Z`, with optional fractional seconds. */
	public static function is_iso_utc( $value ) {
		return 1 === preg_match( '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/', (string) $value );
	}

	/** Strictly after — the parameter is `_gt`, and a replayed watermark must not repeat. */
	public static function is_after( $timestamp, $since ) {
		$left  = self::parse_iso( $timestamp );
		$right = self::parse_iso( $since );
		if ( null === $left || null === $right ) {
			return false;
		}
		return $left->format( 'U.u' ) > $right->format( 'U.u' );
	}

	private static function parse_iso( $value ) {
		if ( ! self::is_iso_utc( $value ) ) {
			return null;
		}
		try {
			return new DateTimeImmutable( (string) $value );
		} catch ( Exception $error ) {
			return null;
		}
	}

	// ---------------------------------------------------------------------
	// Records
	// ---------------------------------------------------------------------

	/**
	 * Shape one attribution row, or `null` when it must not be sent.
	 *
	 * A row without a click id is not an attributed purchase and must never appear —
	 * the documents require the endpoint to expose *only* referred orders. An unknown
	 * status is dropped for the same reason: the vocabulary is closed to
	 * `completed`/`cancelled`, and guessing would report a sale Torob cannot settle.
	 */
	public static function order_record( $row, $since ) {
		$row = is_array( $row ) ? $row : array();

		$clid = isset( $row['torob_clid'] ) ? (string) $row['torob_clid'] : '';
		if ( ! self::clid_is_valid( $clid ) ) {
			return null;
		}
		$purchase = isset( $row['purchase_timestamp'] ) ? (string) $row['purchase_timestamp'] : '';
		if ( null === self::parse_iso( $purchase ) || ! self::is_after( $purchase, $since ) ) {
			return null;
		}
		$status = self::status_value( isset( $row['status'] ) ? $row['status'] : '' );
		if ( null === $status ) {
			return null;
		}

		$record = array(
			'purchase_timestamp'     => $purchase,
			'last_updated_timestamp' => self::timestamp_or( isset( $row['last_updated_timestamp'] ) ? $row['last_updated_timestamp'] : '', $purchase ),
			'torob_clid'             => $clid,
			'status'                 => $status,
		);

		if ( isset( $row['psp'] ) && '' !== trim( (string) $row['psp'] ) ) {
			$record['psp'] = (string) $row['psp'];
		}
		foreach ( array( 'order_value', 'shipping_amount' ) as $money ) {
			if ( isset( $row[ $money ] ) && null !== $row[ $money ] && '' !== $row[ $money ] ) {
				$record[ $money ] = (int) $row[ $money ];
			}
		}
		if ( isset( $row['phone_number'] ) && '' !== trim( (string) $row['phone_number'] ) ) {
			$record['phone_number'] = (string) $row['phone_number'];
		}

		$products = array();
		if ( isset( $row['products'] ) && is_array( $row['products'] ) ) {
			foreach ( $row['products'] as $product ) {
				$product = (array) $product;
				$url     = isset( $product['product_url'] ) ? (string) $product['product_url'] : '';
				// The three fields are conditional-but-all-or-nothing: a partial line
				// would be rejected by the poller, so an unusable one is left out
				// rather than sent half-filled.
				if ( 0 !== strpos( $url, 'http://' ) && 0 !== strpos( $url, 'https://' ) ) {
					continue;
				}
				if ( ! isset( $product['product_price'], $product['quantity'] ) ) {
					continue;
				}
				$products[] = array(
					'product_url'   => $url,
					'product_price' => (int) $product['product_price'],
					'quantity'      => (int) $product['quantity'],
				);
			}
		}
		if ( $products ) {
			$record['products'] = $products;
		}

		return $record;
	}

	/** The same, for the action feed. `action_type` is required, so a blank one is dropped. */
	public static function action_record( $row, $since ) {
		$row = is_array( $row ) ? $row : array();

		$clid = isset( $row['torob_clid'] ) ? (string) $row['torob_clid'] : '';
		if ( ! self::clid_is_valid( $clid ) ) {
			return null;
		}
		$timestamp = isset( $row['timestamp'] ) ? (string) $row['timestamp'] : '';
		if ( null === self::parse_iso( $timestamp ) || ! self::is_after( $timestamp, $since ) ) {
			return null;
		}
		$status = self::status_value( isset( $row['status'] ) ? $row['status'] : '' );
		if ( null === $status ) {
			return null;
		}
		$type = isset( $row['action_type'] ) ? trim( (string) $row['action_type'] ) : '';
		if ( '' === $type ) {
			return null;
		}

		return array(
			'timestamp'              => $timestamp,
			'last_updated_timestamp' => self::timestamp_or( isset( $row['last_updated_timestamp'] ) ? $row['last_updated_timestamp'] : '', $timestamp ),
			'torob_clid'             => $clid,
			'status'                 => $status,
			'action_type'            => $type,
		);
	}

	/**
	 * Filter, order and trim a batch.
	 *
	 * Ascending by the document's own timestamp — the poller resumes from the last one,
	 * so an out-of-order batch would make it skip records it never saw.
	 */
	public static function collect( $rows, $since, $limit, $channel ) {
		$records = array();
		$key     = 'orders' === $channel ? 'purchase_timestamp' : 'timestamp';
		foreach ( (array) $rows as $row ) {
			$record = 'orders' === $channel
				? self::order_record( $row, $since )
				: self::action_record( $row, $since );
			if ( null !== $record ) {
				$records[] = $record;
			}
		}
		usort(
			$records,
			static function ( $left, $right ) use ( $key ) {
				return strcmp( $left[ $key ], $right[ $key ] );
			}
		);
		return array_slice( $records, 0, max( 0, (int) $limit ) );
	}

	public static function response( $records ) {
		return array(
			'success' => true,
			'data'    => array_values( (array) $records ),
		);
	}

	private static function status_value( $value ) {
		$value = strtolower( trim( (string) $value ) );
		if ( 'completed' === $value || 'cancelled' === $value ) {
			return $value;
		}
		return null;
	}

	private static function timestamp_or( $value, $fallback ) {
		$value = (string) $value;
		return null === self::parse_iso( $value ) ? $fallback : $value;
	}

	// ---------------------------------------------------------------------
	// Click capture
	// ---------------------------------------------------------------------

	/**
	 * A click id is an opaque token, not free text: bounded, and restricted to the
	 * characters an id can plausibly use. Anything else is ignored rather than
	 * stored, so a stray `?torob_clid=<script>` cannot become order metadata.
	 */
	public static function clid_is_valid( $value ) {
		$value = (string) $value;
		if ( '' === $value || strlen( $value ) > 128 ) {
			return false;
		}
		return 1 === preg_match( '/^[A-Za-z0-9_.:-]+$/', $value );
	}

	/**
	 * Keep the id Torob appended, for the attribution window.
	 *
	 * Cookie attributes: `Lax` so a normal top-level navigation from Torob carries it,
	 * `Secure` when the site is https, `HttpOnly` because no script on the page needs
	 * to read it, and a 7-day life to match the window the document defines.
	 */
	public static function capture_clid() {
		if ( empty( $_GET[ self::CLID_QUERY ] ) ) {
			return;
		}
		$value = sanitize_text_field( wp_unslash( $_GET[ self::CLID_QUERY ] ) );
		if ( ! self::clid_is_valid( $value ) ) {
			return;
		}
		if ( isset( $_COOKIE[ self::CLID_COOKIE ] ) && $_COOKIE[ self::CLID_COOKIE ] === $value ) {
			return;
		}
		if ( headers_sent() ) {
			return;
		}
		setcookie(
			self::CLID_COOKIE,
			$value,
			array(
				'expires'  => time() + self::CLID_TTL,
				'path'     => '/',
				'secure'   => is_ssl(),
				'httponly' => true,
				'samesite' => 'Lax',
			)
		);
		$_COOKIE[ self::CLID_COOKIE ] = $value;
	}

	/** Copy the click id onto the order, which is what the poll actually reads. */
	public static function attach_clid_to_order( $order ) {
		if ( ! self::clid_is_valid( isset( $_COOKIE[ self::CLID_COOKIE ] ) ? $_COOKIE[ self::CLID_COOKIE ] : '' ) ) {
			return;
		}
		if ( ! is_object( $order ) || ! method_exists( $order, 'update_meta_data' ) ) {
			return;
		}
		$order->update_meta_data( self::CLID_META, sanitize_text_field( wp_unslash( $_COOKIE[ self::CLID_COOKIE ] ) ) );
	}

	// ---------------------------------------------------------------------
	// The endpoints
	// ---------------------------------------------------------------------

	public static function register_routes() {
		register_rest_route(
			'torob/v1',
			'/orders',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'handle_orders' ),
				'permission_callback' => '__return_true',
			)
		);
		register_rest_route(
			'torob/v1',
			'/actions',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'handle_actions' ),
				'permission_callback' => '__return_true',
			)
		);
	}

	public static function handle_orders( $request ) {
		$gate = self::open_channel( $request, 'orders' );
		if ( isset( $gate['status'] ) ) {
			return new WP_REST_Response( $gate['body'], $gate['status'] );
		}

		$rows = array();
		foreach ( self::woocommerce_orders( $gate['since'], $gate['limit'] ) as $order ) {
			$row = self::order_row( $order );
			if ( null !== $row ) {
				$rows[] = $row;
			}
		}

		return new WP_REST_Response( self::response( self::collect( $rows, $gate['since'], $gate['limit'], 'orders' ) ), 200 );
	}

	public static function handle_actions( $request ) {
		$gate = self::open_channel( $request, 'actions' );
		if ( isset( $gate['status'] ) ) {
			return new WP_REST_Response( $gate['body'], $gate['status'] );
		}

		// Nothing is invented: a site that tracks actions supplies them, and everyone
		// else answers an honest empty list (which is also what "no new actions" is).
		$rows = apply_filters( 'pos_connector_torob_actions', array(), $gate['since'], $gate['limit'] );

		return new WP_REST_Response( self::response( self::collect( $rows, $gate['since'], $gate['limit'], 'actions' ) ), 200 );
	}

	/**
	 * Token → switch → parameters, in that order.
	 *
	 * The token comes first so this endpoint is not an oracle for whether a store has
	 * attribution switched on, and the switch comes before any query so a disabled
	 * store never touches an order.
	 */
	private static function open_channel( $request, $channel ) {
		$headers = array();
		foreach ( $request->get_headers() as $name => $values ) {
			$headers[ $name ] = is_array( $values ) ? implode( ',', $values ) : $values;
		}

		$verified = self::verify_token( $headers, self::site_hosts() );
		if ( empty( $verified['ok'] ) ) {
			return array(
				'status' => 401,
				'body'   => array(
					'success' => false,
					'error'   => $verified['reason'],
				),
			);
		}

		$gate = self::guard( $channel );
		if ( null !== $gate ) {
			return $gate;
		}

		$params = self::parse_params( $request->get_query_params(), $channel );
		if ( empty( $params['ok'] ) ) {
			return array(
				'status' => 400,
				'body'   => array(
					'success' => false,
					'error'   => $params['error'],
				),
			);
		}

		return $params;
	}

	/** The site's own host first; the request's `Host` only as a tolerated spelling. */
	private static function site_hosts() {
		$hosts = array();
		$home  = wp_parse_url( home_url(), PHP_URL_HOST );
		if ( $home ) {
			$hosts[] = $home;
		}
		if ( ! empty( $_SERVER['HTTP_HOST'] ) ) {
			$hosts[] = sanitize_text_field( wp_unslash( $_SERVER['HTTP_HOST'] ) );
		}
		return $hosts;
	}

	/** Attributed orders only, oldest first, bounded by the caller's limit. */
	private static function woocommerce_orders( $since, $limit ) {
		if ( ! function_exists( 'wc_get_orders' ) ) {
			return array();
		}
		$orders = array();
		$page   = 1;
		// Only orders carrying a click id are candidates, so this pages over the
		// attributed set rather than the whole order table.
		while ( count( $orders ) < $limit && $page <= 20 ) {
			$batch = wc_get_orders(
				array(
					'limit'        => min( 100, $limit ),
					'page'         => $page,
					'orderby'      => 'date',
					'order'        => 'ASC',
					'paginate'     => false,
					'meta_query'   => array(
						array(
							'key'     => self::CLID_META,
							'compare' => 'EXISTS',
						),
					),
				)
			);
			if ( empty( $batch ) ) {
				break;
			}
			foreach ( $batch as $order ) {
				$orders[] = $order;
			}
			if ( count( $batch ) < min( 100, $limit ) ) {
				break;
			}
			++$page;
		}
		return $orders;
	}

	/**
	 * One WooCommerce order as the poll's raw row.
	 *
	 * WooCommerce's own statuses are mapped onto the document's closed vocabulary:
	 * a cancelled or refunded order is `cancelled`, everything else `completed`.
	 * Money passes through `pos_connector_torob_amount` so a store priced in Rial can
	 * divide by ten instead of reporting a hundredfold sale.
	 */
	private static function order_row( $order ) {
		if ( ! is_object( $order ) || ! method_exists( $order, 'get_meta' ) ) {
			return null;
		}
		$clid = (string) $order->get_meta( self::CLID_META );
		if ( ! self::clid_is_valid( $clid ) ) {
			return null;
		}

		$created  = $order->get_date_created();
		$modified = $order->get_date_modified();
		if ( ! $created ) {
			return null;
		}

		$status = $order->get_status();
		$cancelled = in_array( $status, array( 'cancelled', 'refunded', 'failed' ), true );

		$products = array();
		foreach ( $order->get_items() as $item ) {
			$product = method_exists( $item, 'get_product' ) ? $item->get_product() : null;
			$url     = $product && method_exists( $product, 'get_permalink' ) ? $product->get_permalink() : '';
			if ( ! $url ) {
				continue;
			}
			// `product_price` is the price of **one unit**, so a line subtotal is
			// divided by its quantity rather than reported as the unit price.
			$quantity = (int) $item->get_quantity();
			$line     = (float) $order->get_item_subtotal( $item, false, false );
			$products[] = array(
				'product_url'   => $url,
				'product_price' => self::to_toman( $quantity > 1 ? $line / $quantity : $line ),
				'quantity'      => $quantity,
			);
		}

		return array(
			'purchase_timestamp'     => self::iso_utc( $created ),
			'last_updated_timestamp' => self::iso_utc( $modified ? $modified : $created ),
			'torob_clid'             => $clid,
			'status'                 => $cancelled ? 'cancelled' : 'completed',
			'psp'                    => (string) $order->get_payment_method(),
			'order_value'            => self::to_toman( (float) $order->get_subtotal() - (float) $order->get_total_discount() ),
			'shipping_amount'        => self::to_toman( (float) $order->get_shipping_total() ),
			'phone_number'           => (string) $order->get_billing_phone(),
			'products'               => $products,
		);
	}

	private static function to_toman( $amount ) {
		$amount = (float) $amount;
		return (int) round( (float) apply_filters( 'pos_connector_torob_amount', $amount ) );
	}

	private static function iso_utc( $date ) {
		if ( ! is_object( $date ) || ! method_exists( $date, 'format' ) ) {
			return '';
		}
		return gmdate( 'Y-m-d\TH:i:s', $date->getTimestamp() ) . '.000000Z';
	}

	// ---------------------------------------------------------------------
	// The merchant's switch
	// ---------------------------------------------------------------------

	/** What is shared, and with whom — the copy the documents say must accompany a switch. */
	public static function channel_copy() {
		return array(
			'orders'  => array(
				'label'   => __( 'اشتراک سفارش‌های آمده از ترب', 'pos-accounting-connector' ),
				'summary' => __( 'اگر روشن باشد، ترب می‌تواند سفارش‌هایی را بخواند که با کلیک از ترب آمده‌اند: زمان خرید، مبلغ، هزینه ارسال، شماره تماس، اقلام و وضعیت (تکمیل‌شده یا لغوشده). سفارش‌هایی که از ترب نیامده‌اند هرگز فرستاده نمی‌شوند.', 'pos-accounting-connector' ),
			),
			'actions' => array(
				'label'   => __( 'اشتراک رویدادهای آمده از ترب', 'pos-accounting-connector' ),
				'summary' => __( 'اگر روشن باشد، ترب می‌تواند رویدادهایی را بخواند که با کلیک از ترب آمده‌اند. این افزونه به‌خودی خود رویدادی نمی‌سازد؛ اگر فروشگاه رویدادی ثبت می‌کند، آن را از فیلتر pos_connector_torob_actions به ترب می‌رساند.', 'pos-accounting-connector' ),
			),
		);
	}

	public static function render_admin() {
		$copy = self::channel_copy();
		?>
		<section class="pos-panel">
			<h2><?php esc_html_e( 'ترب', 'pos-accounting-connector' ); ?></h2>
			<p>
				<?php esc_html_e( 'این دو کلید پیش‌فرض خاموش‌اند. ترب بدون روشن‌کردن صریح هر کلید، پاسخ ۴۰۳ می‌گیرد و هیچ سفارشی خوانده نمی‌شود.', 'pos-accounting-connector' ); ?>
			</p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="pos_connector_save_torob" />
				<?php wp_nonce_field( 'pos_connector_save_torob' ); ?>
				<table class="form-table" role="presentation">
					<?php foreach ( $copy as $channel => $entry ) : ?>
						<tr>
							<th scope="row"><?php echo esc_html( $entry['label'] ); ?></th>
							<td>
								<label>
									<input type="checkbox" name="torob_<?php echo esc_attr( $channel ); ?>" value="1" <?php checked( self::is_enabled( $channel ) ); ?> />
									<?php esc_html_e( 'اجازه می‌دهم', 'pos-accounting-connector' ); ?>
								</label>
								<p class="description"><?php echo esc_html( $entry['summary'] ); ?></p>
							</td>
						</tr>
					<?php endforeach; ?>
				</table>
				<?php submit_button( __( 'ذخیره', 'pos-accounting-connector' ) ); ?>
			</form>
			<p class="description">
				<?php esc_html_e( 'نشانی‌هایی که ترب باید بخواند:', 'pos-accounting-connector' ); ?>
				<code><?php echo esc_html( rest_url( 'torob/v1/orders' ) ); ?></code>
				<code><?php echo esc_html( rest_url( 'torob/v1/actions' ) ); ?></code>
			</p>
		</section>
		<?php
	}

	public static function handle_save() {
		if ( ! current_user_can( pos_connector_admin_capability() ) ) {
			wp_die( esc_html__( 'دسترسی مجاز نیست.', 'pos-accounting-connector' ) );
		}
		check_admin_referer( 'pos_connector_save_torob' );

		self::set_enabled( 'orders', ! empty( $_POST['torob_orders'] ) );
		self::set_enabled( 'actions', ! empty( $_POST['torob_actions'] ) );

		wp_safe_redirect( add_query_arg( 'pos_notice', 'saved', wp_get_referer() ? wp_get_referer() : admin_url() ) );
		exit;
	}
}
