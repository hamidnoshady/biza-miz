<?php
/**
 * Issue #894 Wave 3 (connector half) — **Product API v3 served by the store itself**.
 *
 * The platform-hosted endpoint (`/api/v1/torob/products/<shopId>`) is one of the two
 * deployables the issue names. The other is this: the same contract, answered from the
 * shop's own origin, which is what Torob needs wherever the platform does not
 * terminate that shop's domain — the token's `aud` is the domain, by design.
 *
 * The contract is not re-derived here. Every rule comes from the same published
 * document the platform follows (`product_api_v3.md`), and the strings returned on a
 * `400` are Torob's own sentences, copied from `src/lib/torob/contract.ts` because a
 * shop that answers with a different sentence than the hosted endpoint is a shop
 * whose integration fails differently. What is shared by construction:
 *
 *   1. **Exactly one request mode, no defaults** — `page_urls`, `page_uniques`,
 *      `page` + `sort`, or `cursor` + `sort`. Empty, ambiguous or missing `sort` is a
 *      `400` with `{ error }`, never a silent page 1.
 *   2. **100 per page**, `max_pages = ceil(total / 100)`.
 *   3. **`spec` is required and is a dictionary** — `{}` when there is nothing to say.
 *   4. **A withdrawn product is absent.** A lookup of one answers `total: 0` and an
 *      empty list; it is never a stub and never a 404.
 *
 * The price trap the document names twice: `current_price: 0` with
 * `availability: true` reads as **free**. So an unavailable product is sent as
 * `false` + `0`, and a product that is not for sale is not sent at all.
 *
 * Order of operations, as on the platform: token → connection → body. The token is
 * verified **before** anything is read from the catalogue, so an unauthenticated
 * caller cannot make a store assemble 100 products; and the audience is this site's
 * own host, never the request's `Host` header.
 *
 * Everything decidable without WordPress is a pure static function, so
 * `wordpress-plugin/tests/connector-torob-products.php` pins the parsing, the mapping,
 * the paging and the gate under plain `php`.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class POS_Connector_Torob_Products {

	const API_VERSION = 'torob_api_v3';

	/** Fixed by the contract. */
	const PAGE_SIZE = 100;

	const SORTS = array( 'date_added_desc', 'date_updated_desc', 'product_id_desc' );

	/** Cursor pagination is defined only over this sort. */
	const CURSOR_SORT = 'product_id_desc';

	/** The document's field caps, in characters. */
	const LIMITS = array(
		'page_unique' => 200,
		'page_url'    => 1500,
		'title'       => 500,
		'subtitle'    => 500,
		'group_id'    => 200,
		'category'    => 200,
		'short_desc'  => 500,
		'image'       => 1000,
	);

	/**
	 * Torob's own sentences, verbatim from the published contract.
	 *
	 * Not translated into this plugin's voice on purpose: these strings are what the
	 * hosted endpoint answers, and Torob's fetcher logs them.
	 */
	const ERROR_MESSAGE = array(
		'body_not_object'                 => 'request body must be a JSON object',
		'multiple_modes'                  => 'request must use exactly one of page_urls, page_uniques, page, or cursor',
		'empty_request'                   => 'request body is empty: send page_urls, page_uniques, page, or cursor',
		'sort_required'                   => 'sort parameter is not provided',
		'page_invalid'                    => 'page must be an integer greater than or equal to 1',
		'page_urls_invalid'               => 'page_urls must be a non-empty list of absolute URLs',
		'page_uniques_invalid'            => 'page_uniques must be a non-empty list of strings',
		'cursor_invalid'                  => 'cursor must be a non-empty string',
		'cursor_requires_product_id_desc' => 'cursor pagination requires sort product_id_desc',
	);

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	public static function register_routes() {
		register_rest_route(
			'torob/v1',
			'/products',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'handle' ),
				'permission_callback' => '__return_true',
			)
		);
	}

	// ---------------------------------------------------------------------
	// The gate
	// ---------------------------------------------------------------------

	/**
	 * Token → connection → body, in that order, as the platform does it.
	 *
	 * `$connected` is the store's own side of enrollment — a configured base URL and
	 * token, the same pair every other job needs. A store that was never connected has
	 * not enrolled in the channel, so it says so instead of serving a catalogue.
	 *
	 * There is deliberately **no per-channel switch here**, unlike orders and actions
	 * (§6h): those share personal data and the document requires an explicit opt-in;
	 * a product catalogue is what the merchant already published on the open web, and
	 * the enrollment that matters — the platform's `torob_shops` row, authorized and
	 * switched on — is the merchant's act on the other side. Nobody can call this
	 * endpoint without Torob's private key either way.
	 *
	 * @return array|null Null when the channel is open, else `array( 'status', 'body' )`.
	 */
	public static function gate( $headers, $hosts, $connected, $now = null ) {
		$verified = POS_Connector_Torob::verify_token( $headers, $hosts, $now );
		if ( empty( $verified['ok'] ) ) {
			return array(
				'status' => 401,
				'body'   => array( 'error' => 'unauthorized: ' . $verified['reason'] ),
			);
		}
		if ( ! $connected ) {
			return array(
				'status' => 403,
				'body'   => array( 'error' => 'not_connected' ),
			);
		}
		return null;
	}

	// ---------------------------------------------------------------------
	// The request
	// ---------------------------------------------------------------------

	/**
	 * Parse a body strictly, exactly as `parseTorobRequest` does on the platform.
	 *
	 * Unknown keys are ignored (a future optional field must not break every shop);
	 * ambiguity and "no mode at all" are refused, because the document says not to
	 * default.
	 *
	 * @param mixed $body Decoded JSON, or the raw string when decoding failed.
	 * @return array{ok:bool,request?:array,error?:string}
	 */
	public static function parse_request( $body ) {
		if ( is_string( $body ) ) {
			// Decoded **without** assoc first, because PHP folds `{}` and `[]` into the
			// same array and the contract tells them apart: `{}` names no mode, `[]` is
			// not an object at all.
			$shaped = json_decode( $body );
			if ( JSON_ERROR_NONE !== json_last_error() ) {
				// A body that is not JSON at all is still "not an object".
				return self::bad( 'body_not_object' );
			}
			if ( ! is_object( $shaped ) ) {
				return self::bad( 'body_not_object' );
			}
			$body = json_decode( $body, true );
		}
		if ( ! is_array( $body ) ) {
			return self::bad( 'body_not_object' );
		}
		// Callers that hand in an already-decoded array: a non-empty list is a JSON
		// array, not an object.
		if ( $body && array_keys( $body ) === range( 0, count( $body ) - 1 ) ) {
			return self::bad( 'body_not_object' );
		}

		$has_urls    = array_key_exists( 'page_urls', $body );
		$has_uniques = array_key_exists( 'page_uniques', $body );
		$has_page    = array_key_exists( 'page', $body );
		$has_cursor  = array_key_exists( 'cursor', $body );

		$modes = (int) $has_urls + (int) $has_uniques + (int) $has_page + (int) $has_cursor;
		if ( 0 === $modes ) {
			return self::bad( 'empty_request' );
		}
		if ( $modes > 1 ) {
			return self::bad( 'multiple_modes' );
		}

		if ( $has_urls ) {
			$value = $body['page_urls'];
			if ( ! is_array( $value ) || ! $value ) {
				return self::bad( 'page_urls_invalid' );
			}
			foreach ( $value as $entry ) {
				if ( ! is_string( $entry ) || ! self::is_absolute_url( $entry ) ) {
					return self::bad( 'page_urls_invalid' );
				}
			}
			return self::good( array( 'mode' => 'page_urls', 'page_urls' => array_values( $value ) ) );
		}

		if ( $has_uniques ) {
			$value = $body['page_uniques'];
			if ( ! is_array( $value ) || ! $value ) {
				return self::bad( 'page_uniques_invalid' );
			}
			$uniques = array();
			foreach ( $value as $entry ) {
				if ( ! is_string( $entry ) || '' === trim( $entry ) ) {
					return self::bad( 'page_uniques_invalid' );
				}
				$uniques[] = trim( $entry );
			}
			return self::good( array( 'mode' => 'page_uniques', 'page_uniques' => $uniques ) );
		}

		if ( ! array_key_exists( 'sort', $body ) ) {
			return self::bad( 'sort_required' );
		}
		$sort = $body['sort'];
		if ( ! is_string( $sort ) || ! in_array( $sort, self::SORTS, true ) ) {
			return self::bad( 'sort_invalid' );
		}

		if ( $has_cursor ) {
			$cursor = $body['cursor'];
			// `"cursor": null` is the document's own shape for the first cursor page.
			if ( null !== $cursor && ( ! is_string( $cursor ) || '' === trim( $cursor ) ) ) {
				return self::bad( 'cursor_invalid' );
			}
			if ( self::CURSOR_SORT !== $sort ) {
				return self::bad( 'cursor_requires_product_id_desc' );
			}
			return self::good(
				array(
					'mode'   => 'cursor',
					'cursor' => is_string( $cursor ) ? trim( $cursor ) : null,
					'sort'   => $sort,
				)
			);
		}

		$page = $body['page'];
		// JSON numbers do not distinguish `3` from `3.0`; a fraction does not round to
		// a page, it simply is not one.
		$is_integer = is_int( $page ) || ( is_float( $page ) && floor( $page ) === $page );
		if ( ! $is_integer || $page < 1 ) {
			return self::bad( 'page_invalid' );
		}
		return self::good(
			array(
				'mode' => 'page',
				'page' => $page,
				'sort' => $sort,
			)
		);
	}

	private static function good( $request ) {
		return array(
			'ok'      => true,
			'request' => $request,
		);
	}

	private static function bad( $error ) {
		return array(
			'ok'    => false,
			'error' => $error,
		);
	}

	/** The `{ error }` body for a parse failure — Torob's sentence, not our code. */
	public static function error_body( $error ) {
		if ( 'sort_invalid' === $error ) {
			return array( 'error' => 'sort must be one of ' . implode( ', ', self::SORTS ) );
		}
		return array( 'error' => isset( self::ERROR_MESSAGE[ $error ] ) ? self::ERROR_MESSAGE[ $error ] : $error );
	}

	public static function is_absolute_url( $value ) {
		$parts = wp_parse_url_standin( (string) $value );
		return is_array( $parts ) && isset( $parts['scheme'], $parts['host'] )
			&& in_array( strtolower( $parts['scheme'] ), array( 'http', 'https' ), true );
	}

	// ---------------------------------------------------------------------
	// One product
	// ---------------------------------------------------------------------

	/**
	 * Shape one catalogue row into the contract's record, or `null` when it must not
	 * be sent at all.
	 *
	 * The row is the plain array `row_from_product()` produces, so this function has
	 * no WooCommerce dependency and can be pinned by a test:
	 *
	 *   id, url, title, subtitle, price_toman, old_price_toman, available, sellable,
	 *   images[], category, short_desc, spec{}, date_added, date_updated, group_id,
	 *   seller_name, seller_city, guarantee
	 *
	 * What is refused, and why:
	 *   - `sellable === false` — withdrawn, so absent (contract rule 4);
	 *   - no parseable `date_added` — required, and a fabricated timestamp is worse
	 *     than a missing listing;
	 *   - no usable absolute `url`, or no image — Torob cannot show either.
	 */
	public static function record( $row ) {
		$row = is_array( $row ) ? $row : array();

		if ( isset( $row['sellable'] ) && false === $row['sellable'] ) {
			return null;
		}

		$added = self::iso_timestamp( isset( $row['date_added'] ) ? $row['date_added'] : '' );
		if ( null === $added ) {
			return null;
		}

		$url = isset( $row['url'] ) ? trim( (string) $row['url'] ) : '';
		if ( ! self::is_absolute_url( $url ) ) {
			return null;
		}

		$images = array();
		foreach ( (array) ( isset( $row['images'] ) ? $row['images'] : array() ) as $image ) {
			$clamped = self::clamp( (string) $image, self::LIMITS['image'] );
			if ( null !== $clamped ) {
				$images[] = $clamped;
			}
		}
		if ( ! $images ) {
			return null;
		}

		$unique = self::clamp( isset( $row['id'] ) ? (string) $row['id'] : '', self::LIMITS['page_unique'] );
		if ( null === $unique || strlen( $unique ) > self::LIMITS['page_unique'] ) {
			return null;
		}
		$title = self::clamp( isset( $row['title'] ) ? (string) $row['title'] : '', self::LIMITS['title'] );
		if ( null === $title ) {
			return null;
		}

		$available = isset( $row['available'] ) ? (bool) $row['available'] : true;
		$toman     = isset( $row['price_toman'] ) ? $row['price_toman'] : null;
		if ( ! is_int( $toman ) || $toman < 0 || $toman > 100000000000 ) {
			// Never turn an unsupported/invalid amount into `0`: true + zero means
			// FREE to Torob. `null` is the connector's explicit "do not publish".
			return null;
		}
		$toman = is_int( $toman ) ? $toman : 0;

		if ( strlen( $url ) > self::LIMITS['page_url'] ) {
			return null;
		}
		$record = array(
			'page_unique'  => $unique,
			'page_url'     => $url,
			'title'        => $title,
			// The trap: `true` + `0` is free. An unavailable product never carries a
			// price, and an available one never carries a zero it did not earn.
			'current_price' => $available ? $toman : 0,
			'availability' => $available,
			'image_links'  => $images,
			// Required, and a dictionary — `{}` when there is nothing to say.
			'spec'         => self::spec( isset( $row['spec'] ) ? $row['spec'] : array() ),
			'date_added'   => $added,
		);

		$subtitle = self::clamp( isset( $row['subtitle'] ) ? (string) $row['subtitle'] : '', self::LIMITS['subtitle'] );
		if ( null !== $subtitle ) {
			$record['subtitle'] = $subtitle;
		}
		$group = self::clamp( isset( $row['group_id'] ) ? (string) $row['group_id'] : '', self::LIMITS['group_id'] );
		if ( null !== $group ) {
			// Variations of one product share a group id, which is how Torob knows they
			// are the same thing in different colours rather than unrelated listings.
			$record['product_group_id'] = $group;
		}
		$category = self::clamp( isset( $row['category'] ) ? (string) $row['category'] : '', self::LIMITS['category'] );
		if ( null !== $category ) {
			$record['category_name'] = $category;
		}
		$short = self::clamp( isset( $row['short_desc'] ) ? (string) $row['short_desc'] : '', self::LIMITS['short_desc'] );
		if ( null !== $short ) {
			$record['short_desc'] = $short;
		}
		$updated = self::iso_timestamp( isset( $row['date_updated'] ) ? $row['date_updated'] : '' );
		if ( null !== $updated ) {
			$record['date_updated'] = $updated;
		}
		foreach ( array( 'seller_name', 'seller_city', 'guarantee' ) as $field ) {
			$value = self::clamp( isset( $row[ $field ] ) ? (string) $row[ $field ] : '', 200 );
			if ( null !== $value ) {
				$record[ $field ] = $value;
			}
		}
		// `old_price` only when it is genuinely higher: a "was" price at or below the
		// current one is a discount Torob would show as a fake strike-through.
		if ( isset( $row['old_price_toman'] ) && null !== $row['old_price_toman'] ) {
			$old = (int) $row['old_price_toman'];
			if ( $available && $old > $toman && $toman > 0 ) {
				$record['old_price'] = $old;
			}
		}

		return $record;
	}

	/** A dictionary of strings and numbers, as the contract requires. */
	public static function spec( $value ) {
		$spec = array();
		foreach ( (array) $value as $name => $entry ) {
			$name = trim( (string) $name );
			if ( '' === $name || is_array( $entry ) || is_object( $entry ) || null === $entry ) {
				continue;
			}
			$spec[ $name ] = is_int( $entry ) || is_float( $entry ) ? $entry : (string) $entry;
		}
		return $spec;
	}

	/** Trim to the cap, or drop a field that is empty — never send `""`. */
	public static function clamp( $value, $limit ) {
		$trimmed = trim( (string) $value );
		if ( '' === $trimmed ) {
			return null;
		}
		return strlen( $trimmed ) > $limit ? substr( $trimmed, 0, $limit ) : $trimmed;
	}

	/**
	 * Timezone-aware ISO 8601, or `null` for anything unparseable.
	 *
	 * The platform sends `toISOString()`; this matches it exactly, including the
	 * millisecond field, so a shop's records and the hosted endpoint's are the same
	 * shape to Torob's parser.
	 */
	public static function iso_timestamp( $value ) {
		if ( '' === (string) $value ) {
			return null;
		}
		try {
			$date = new DateTimeImmutable( (string) $value );
		} catch ( Exception $error ) {
			return null;
		}
		return gmdate( 'Y-m-d\TH:i:s', $date->getTimestamp() ) . '.000Z';
	}

	// ---------------------------------------------------------------------
	// Paging and lookups
	// ---------------------------------------------------------------------

	/** Total pages at the contract's page size. */
	public static function max_pages( $total ) {
		return max( 1, (int) ceil( ( (int) $total ) / self::PAGE_SIZE ) );
	}

	/**
	 * A page of records, wrapped in the documented envelope.
	 *
	 * `page` mode only: ordering is done by the caller's query, because WooCommerce can
	 * sort the whole catalogue where PHP cannot hold it.
	 */
	public static function page_response( $records, $page, $total ) {
		return array(
			'api_version'  => self::API_VERSION,
			'current_page' => (int) $page,
			'total'        => (int) $total,
			'max_pages'    => self::max_pages( $total ),
			'next_cursor'  => null,
			'products'     => array_values( (array) $records ),
		);
	}

	/** A cursor page: no page number, and a cursor only when there is more. */
	public static function cursor_response( $records, $has_more ) {
		$last = $has_more && $records ? $records[ count( $records ) - 1 ]['page_unique'] : null;
		return array(
			'api_version' => self::API_VERSION,
			'total'       => count( (array) $records ),
			'max_pages'   => null,
			'next_cursor' => null === $last ? null : self::encode_cursor( $last ),
			'products'    => array_values( (array) $records ),
		);
	}

	/** A lookup answer: a withdrawn product is absent, so `total: 0` and no pages. */
	public static function lookup_response( $records ) {
		return self::page_response( $records, 1, count( (array) $records ) );
	}

	public static function encode_cursor( $page_unique ) {
		return rtrim( strtr( base64_encode( (string) $page_unique ), '+/', '-_' ), '=' );
	}

	/** The `page_unique` a cursor points at, or `''` when it is not one of ours. */
	public static function decode_cursor( $cursor ) {
		$str = (string) $cursor;
		$str = strtr( $str, '-_', '+/' );
		$remainder = strlen( $str ) % 4;
		if ( 0 !== $remainder ) {
			$str .= str_repeat( '=', 4 - $remainder );
		}
		$decoded = base64_decode( $str, true );
		return false === $decoded ? '' : $decoded;
	}

	/**
	 * `page_urls` children: match on the URL, tolerating a trailing slash and a query
	 * string, which are the two ways the same page is written in the wild.
	 */
	public static function strip_url( $url ) {
		$parts = wp_parse_url_standin( (string) $url );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) ) {
			return '';
		}
		$path = isset( $parts['path'] ) ? rtrim( $parts['path'], '/' ) : '';
		return strtolower( $parts['host'] ) . $path;
	}

	// ---------------------------------------------------------------------
	// The route
	// ---------------------------------------------------------------------

	public static function handle( $request ) {
		$headers = array();
		foreach ( $request->get_headers() as $name => $values ) {
			$headers[ $name ] = is_array( $values ) ? implode( ',', $values ) : $values;
		}

		$settings  = function_exists( 'pos_connector_settings' ) ? pos_connector_settings() : array();
		$connected = ! empty( $settings['enabled'] ) && ! empty( $settings['base_url'] ) && ! empty( $settings['token'] );

		$gate = self::gate( $headers, POS_Connector_Torob::site_hosts(), $connected );
		if ( null !== $gate ) {
			return new WP_REST_Response( $gate['body'], $gate['status'] );
		}

		$parsed = self::parse_request( (string) $request->get_body() );
		if ( empty( $parsed['ok'] ) ) {
			return new WP_REST_Response( self::error_body( $parsed['error'] ), 400 );
		}

		$result = self::serve( $parsed['request'] );
		return new WP_REST_Response( $result['body'], $result['status'] );
	}

	/** Answer an authenticated, well-formed request. */
	public static function serve( $request ) {
		if ( 'page' === $request['mode'] ) {
			return self::serve_page( $request );
		}
		if ( 'cursor' === $request['mode'] ) {
			return self::serve_cursor( $request );
		}
		return self::serve_lookup( $request );
	}

	private static function ok( $body ) {
		return array(
			'status' => 200,
			'body'   => $body,
		);
	}

	/** `page` mode: WooCommerce sorts and pages; this only shapes. */
	private static function serve_page( $request ) {
		$records = self::all_records();
		$records = self::sort_records( $records, $request['sort'] );
		$total   = count( $records );
		$max     = self::max_pages( $total );
		$page    = max( 1, min( $max, (int) $request['page'] ) );
		$start   = ( $page - 1 ) * self::PAGE_SIZE;
		return self::ok( self::page_response( array_slice( $records, $start, self::PAGE_SIZE ), $page, $total ) );
	}

	/**
	 * `cursor` mode: strictly older than the id the cursor names.
	 *
	 * This is the one query WooCommerce cannot express (`ID < x`), and offset paging
	 * over an ID sort — the "obvious" substitute — shifts under a catalogue that is
	 * being edited mid-crawl, which is exactly what a cursor exists to avoid.
	 */
	private static function serve_cursor( $request ) {
		$after = null === $request['cursor'] ? null : self::decode_cursor( $request['cursor'] );
		if ( null !== $after && '' === $after ) {
			return array(
				'status' => 400,
				'body'   => self::error_body( 'cursor_invalid' ),
			);
		}

		$records = self::sort_records( self::all_records(), 'product_id_desc' );
		if ( null !== $after ) {
			$records = array_values(
				array_filter(
					$records,
					static function ( $record ) use ( $after ) {
						return strcmp( (string) $record['page_unique'], (string) $after ) < 0;
					}
				)
			);
		}
		$has_more = count( $records ) > self::PAGE_SIZE;
		$page     = array_slice( $records, 0, self::PAGE_SIZE );
		return self::ok( self::cursor_response( $page, $has_more ) );
	}

	/** `page_urls` and `page_uniques`: a direct lookup, absent when unknown. */
	private static function serve_lookup( $request ) {
		$products = array();
		if ( 'page_uniques' === $request['mode'] ) {
			foreach ( $request['page_uniques'] as $unique ) {
				$product = ctype_digit( (string) $unique ) && function_exists( 'wc_get_product' )
					? wc_get_product( (int) $unique )
					: null;
				if ( $product ) {
					$products[] = $product;
				}
			}
			return self::ok( self::lookup_response( self::records_for( $products ) ) );
		}

		// URLs are matched against the products' own permalinks rather than resolved
		// through `url_to_postid`, because that helper trusts the request's host while
		// this comparison must not.
		$wanted  = array_flip( array_map( 'trim', $request['page_urls'] ) );
		$records = array();
		foreach ( self::all_products() as $product ) {
			foreach ( self::rows_from_product( $product ) as $row ) {
				// Only the page that was asked for: a URL lookup of one variation must
				// not answer with the whole family.
				if ( ! isset( $wanted[ trim( $row['url'] ) ] ) ) {
					continue;
				}
				$record = self::record( $row );
				if ( null !== $record ) {
					$records[] = $record;
				}
			}
		}
		return self::ok( self::lookup_response( $records ) );
	}

	/**
	 * The records that are actually publishable, in deterministic catalogue batches.
	 *
	 * The API's `total` and page boundaries describe these records, not the raw count
	 * of WooCommerce products: a product without a valid date/image/price is not a
	 * Torob page and cannot count toward `max_pages`. The batches are discarded as we
	 * go, keeping only the small contract records rather than full Woo product objects.
	 */
	private static function all_records() {
		if ( ! function_exists( 'wc_get_products' ) ) {
			return array();
		}
		$records = array();
		$seen    = array();
		for ( $page = 1; ; $page++ ) {
			$batch = wc_get_products(
				array(
					'limit'   => self::PAGE_SIZE,
					'page'    => $page,
					'status'  => 'publish',
					'orderby' => 'ID',
					'order'   => 'DESC',
				)
			);
			if ( empty( $batch ) ) {
				break;
			}
			foreach ( self::records_for( $batch ) as $record ) {
				$key = strtolower( $record['page_url'] );
				if ( isset( $seen[ $record['page_unique'] ] ) || isset( $seen[ $key ] ) ) {
					continue;
				}
				$seen[ $record['page_unique'] ] = true;
				$seen[ $key ]                   = true;
				$records[]                      = $record;
			}
			if ( count( $batch ) < self::PAGE_SIZE ) {
				break;
			}
		}
		return $records;
	}

	/** Sort records with the exact tie-breakers the hosted feed uses. */
	private static function sort_records( $records, $sort ) {
		usort(
			$records,
			static function ( $a, $b ) use ( $sort ) {
				$unique = strcmp( (string) $a['page_unique'], (string) $b['page_unique'] );
				if ( 'product_id_desc' === $sort ) {
					return -$unique;
				}
				$field = 'date_updated_desc' === $sort ? 'date_updated' : 'date_added';
				$left  = isset( $a[ $field ] ) ? (string) $a[ $field ] : '';
				$right = isset( $b[ $field ] ) ? (string) $b[ $field ] : '';
				if ( 'date_updated_desc' === $sort ) {
					if ( '' === $left && '' !== $right ) {
						return 1;
					}
					if ( '' !== $left && '' === $right ) {
						return -1;
					}
				}
				return strcmp( $right, $left ) ?: $unique;
			}
		);
		return $records;
	}

	/** A catalogue walk for the URL lookup. */
	private static function all_products() {
		if ( ! function_exists( 'wc_get_products' ) ) {
			return array();
		}
		$all = array();
		for ( $page = 1; ; $page++ ) {
			$batch = wc_get_products(
				array(
					'limit'   => 100,
					'page'    => $page,
					'status'  => 'publish',
					'orderby' => 'ID',
					'order'   => 'DESC',
				)
			);
			if ( empty( $batch ) ) {
				break;
			}
			foreach ( $batch as $product ) {
				$all[] = $product;
			}
			if ( count( $batch ) < 100 ) {
				break;
			}
		}
		return $all;
	}

	private static function orderby( $sort ) {
		if ( 'date_updated_desc' === $sort ) {
			return 'modified';
		}
		if ( 'product_id_desc' === $sort ) {
			return 'ID';
		}
		return 'date';
	}

	/** Shape every page of every product (variations included) into records. */
	private static function records_for( $products ) {
		$records = array();
		$seen    = array();
		foreach ( (array) $products as $product ) {
			foreach ( self::rows_from_product( $product ) as $row ) {
				$record = self::record( $row );
				if ( null === $record ) {
					continue;
				}
				// Two rows pointing at one page — a duplicated SKU, or a variation whose
				// permalink collapses back to the parent — would let Torob pick at
				// random, so the first one wins and the rest are left out.
				$key = strtolower( $record['page_url'] );
				if ( isset( $seen[ $record['page_unique'] ] ) || isset( $seen[ $key ] ) ) {
					continue;
				}
				$seen[ $record['page_unique'] ] = true;
				$seen[ $key ]                   = true;
				$records[]                      = $record;
			}
		}
		return $records;
	}

	// ---------------------------------------------------------------------
	// WooCommerce → the plain row `record()` reads
	// ---------------------------------------------------------------------

	/**
	 * One WC product as the plain rows `record()` consumes.
	 *
	 * A variable product becomes **one row per variation**, each with the parent as
	 * its group id — the same shape the platform's feed builder produces for variants,
	 * so a shop served from its own origin and one served from the platform publish
	 * the same pages.
	 */
	public static function rows_from_product( $product ) {
		if ( ! is_object( $product ) || ! method_exists( $product, 'get_id' ) ) {
			return array();
		}

		$type = method_exists( $product, 'get_type' ) ? $product->get_type() : 'simple';

		if ( 'variable' === $type && method_exists( $product, 'get_children' ) ) {
			$rows = array();
			foreach ( (array) $product->get_children() as $child_id ) {
				$child = function_exists( 'wc_get_product' ) ? wc_get_product( $child_id ) : null;
				if ( $child ) {
					$rows[] = self::row( $child, $product );
				}
			}
			return $rows;
		}

		$parent = 'variation' === $type && method_exists( $product, 'get_parent_id' ) && $product->get_parent_id()
			? ( function_exists( 'wc_get_product' ) ? wc_get_product( $product->get_parent_id() ) : null )
			: null;

		return array( self::row( $product, $parent ? $parent : null ) );
	}

	/**
	 * The plain row. Money goes through the same `pos_connector_torob_amount` filter
	 * the order feed uses, so a store priced in Rial divides by ten in one place.
	 */
	private static function row( $product, $parent ) {
		$is_variation = 'variation' === ( method_exists( $product, 'get_type' ) ? $product->get_type() : '' );
		$url          = method_exists( $product, 'get_permalink' ) ? (string) $product->get_permalink() : '';
		$created      = method_exists( $product, 'get_date_created' ) ? $product->get_date_created() : null;
		$modified     = method_exists( $product, 'get_date_modified' ) ? $product->get_date_modified() : null;

		$images = array();
		$image_id = method_exists( $product, 'get_image_id' ) ? (int) $product->get_image_id() : 0;
		if ( ! $image_id && $parent && method_exists( $parent, 'get_image_id' ) ) {
			$image_id = (int) $parent->get_image_id();
		}
		if ( $image_id && function_exists( 'wp_get_attachment_image_url' ) ) {
			$full = wp_get_attachment_image_url( $image_id, 'full' );
			if ( $full ) {
				$images[] = $full;
			}
		}
		// The gallery belongs to the parent product; a variation inherits it.
		$gallery_source = $parent ? $parent : $product;
		if ( method_exists( $gallery_source, 'get_gallery_image_ids' ) ) {
			foreach ( (array) $gallery_source->get_gallery_image_ids() as $gallery_id ) {
				$url_image = function_exists( 'wp_get_attachment_image_url' ) ? wp_get_attachment_image_url( $gallery_id, 'full' ) : '';
				if ( $url_image ) {
					$images[] = $url_image;
				}
			}
		}

		$price = method_exists( $product, 'get_price' ) ? (string) $product->get_price() : '';
		$regular = method_exists( $product, 'get_regular_price' ) ? (string) $product->get_regular_price() : '';

		$spec = self::attributes_spec( $product );
		$category = '';
		if ( function_exists( 'wc_get_product_terms' ) ) {
			$terms = wc_get_product_terms( $product->get_id(), 'product_cat', array( 'fields' => 'names' ) );
			if ( is_array( $terms ) && $terms ) {
				$category = (string) $terms[0];
			}
		}

		$available = true;
		if ( method_exists( $product, 'is_in_stock' ) ) {
			$available = (bool) $product->is_in_stock();
		}
		if ( method_exists( $product, 'is_purchasable' ) && ! $product->is_purchasable() ) {
			$available = false;
		}

		$short = method_exists( $product, 'get_short_description' ) ? (string) $product->get_short_description() : '';
		$short = trim( wp_strip_all_tags( $short ) );

		return array(
			'id'              => (string) $product->get_id(),
			'url'             => $url,
			'title'           => method_exists( $product, 'get_name' ) ? (string) $product->get_name() : '',
			'subtitle'        => $is_variation && $parent ? (string) $parent->get_name() : '',
			'price_toman'     => self::to_toman( $price ),
			// `regular_price` is Woo's "was" price, and only meaningful when it is the
			// price the shopper is not paying today.
			'old_price_toman' => '' === $regular ? null : self::to_toman( $regular ),
			'available'       => $available,
			'images'          => $images,
			'category'        => $category,
			'short_desc'      => $short,
			'spec'            => $spec,
			'date_added'      => self::iso_timestamp( $created ? self::date_string( $created ) : ( $parent && method_exists( $parent, 'get_date_created' ) && $parent->get_date_created() ? self::date_string( $parent->get_date_created() ) : '' ) ),
			'date_updated'    => self::iso_timestamp( $modified ? self::date_string( $modified ) : '' ),
			'group_id'        => $is_variation && $parent ? (string) $parent->get_id() : '',
			'seller_name'     => '',
			'seller_city'     => '',
			'guarantee'       => '',
		);
	}

	private static function date_string( $date ) {
		if ( is_object( $date ) && method_exists( $date, 'getTimestamp' ) ) {
			// A Woo date object's timezone is the store timezone, not necessarily UTC.
			// Convert from its epoch so appending `Z` never lies about local time.
			return gmdate( 'Y-m-d\TH:i:s', $date->getTimestamp() ) . '+00:00';
		}
		return '';
	}

	/** Variation attributes first, then the product's own, as a dictionary. */
	private static function attributes_spec( $product ) {
		$spec = array();
		if ( ! method_exists( $product, 'get_attributes' ) ) {
			return $spec;
		}
		foreach ( (array) $product->get_attributes() as $name => $attribute ) {
			$label = $name;
			if ( is_object( $attribute ) && method_exists( $attribute, 'get_name' ) ) {
				$label = $attribute->get_name();
				// A taxonomy attribute's options are term ids, which would make the
				// spec read as numbers instead of the words a shopper sees.
				if ( method_exists( $attribute, 'is_taxonomy' ) && $attribute->is_taxonomy()
					&& function_exists( 'wc_get_product_terms' ) ) {
					$values = wc_get_product_terms( $product->get_id(), $label, array( 'fields' => 'names' ) );
				} else {
					$values = method_exists( $attribute, 'get_options' ) ? $attribute->get_options() : array();
				}
			} elseif ( is_string( $attribute ) ) {
				$values = array( $attribute );
			} else {
				$values = array();
			}
			$text = implode( '، ', array_filter( array_map( 'strval', (array) $values ), 'strlen' ) );
			if ( '' !== $text ) {
				$spec[ (string) $label ] = $text;
			}
		}
		return $spec;
	}

	public static function to_toman( $amount ) {
		$currency = function_exists( 'get_woocommerce_currency' ) ? strtoupper( (string) get_woocommerce_currency() ) : '';
		$amount   = trim( (string) $amount );
		if ( ! preg_match( '/^\d+(?:\.0+)?$/', $amount ) ) {
			return null;
		}
		$whole = strstr( $amount, '.', true );
		if ( false === $whole ) {
			$whole = $amount;
		}
		// Keep the canonical IRR → IRT conversion exact: no float, no rounding, no
		// fractional Rial quietly becoming a different storefront price.
		if ( 'IRR' === $currency ) {
			if ( 0 !== ( (int) substr( $whole, -1 ) % 10 ) ) {
				return null;
			}
			$default = (int) ( (int) $whole / 10 );
		} elseif ( 'IRT' === $currency ) {
			$default = (int) $whole;
		} else {
			return null;
		}
		$value = apply_filters( 'pos_connector_torob_amount', $default, $amount, $currency );
		if ( ! is_int( $value ) || $value < 0 || $value > 100000000000 ) {
			return null;
		}
		return $value;
	}
}

/**
 * `wp_parse_url` is a thin wrapper WordPress ships over `parse_url`; the pure helpers
 * above are tested outside WordPress, so they use this instead.
 */
if ( ! function_exists( 'wp_parse_url_standin' ) ) {
	function wp_parse_url_standin( $url ) {
		return function_exists( 'wp_parse_url' ) ? wp_parse_url( $url ) : parse_url( $url );
	}
}
