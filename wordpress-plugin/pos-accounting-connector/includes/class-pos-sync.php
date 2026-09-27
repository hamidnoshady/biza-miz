<?php
/**
 * Two-way sync.
 *
 * **WordPress -> POS.** WooCommerce hooks observe what happens in the store and
 * enqueue it. Nothing is sent from inside a hook — see class-pos-queue.php for
 * why putting an HTTP call in the checkout request is not an option.
 *
 * **POS -> WordPress.** The cron run leases jobs from the app and applies them
 * to WooCommerce: stock levels, prices, whole-product updates, order statuses
 * and refunds; plus requests for a full catalogue, customer or order export.
 * Every job is acked, so the app knows what landed and what to retry.
 *
 * The payloads are deliberately WooCommerce's own REST shapes (`id`,
 * `line_items`, `regular_price`, `billing`). The app already knows how to read
 * those — it has been ingesting them from webhooks since the REST integration
 * shipped — so both connection modes feed one ingest path, and a store can
 * migrate from one mode to the other without a single order changing shape.
 *
 * ## The order-line fix (1.1.0)
 *
 * An order line used to carry `product_id` only. That looked harmless and was
 * not: for a variable product, `WC_Order_Item_Product::get_product()` returns
 * the *variation*, so this plugin sent the variation's id in `product_id` —
 * while a WooCommerce webhook sends the parent's id there and the variation's
 * id in `variation_id`. The same order, in the same app, resolved to two
 * different products depending on how the store was connected.
 *
 * Both ids are now sent, with WooCommerce's own names, and the app resolves
 * `variation_id` first. One shape, one answer, both doors.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Sync {

	/** Guards against a hook firing twice in one request for the same object. */
	private static $seen = array();

	/** How many orders one sweep may re-send, so a cron run finishes inside PHP's limit. */
	const ORDER_SWEEP_LIMIT = 200;

	/**
	 * Most rows one push may carry. The app's own cap is 100 events per request.
	 */
	const PUSH_BATCH_ROWS = 100;

	/**
	 * Most payload bytes one push may carry, comfortably under the app's 2 MB
	 * body limit — the envelope and JSON's own escaping sit on top of what is
	 * measured here.
	 */
	const PUSH_BATCH_BYTES = 1200000;

	/**
	 * How long one cron run may spend pushing, in seconds.
	 *
	 * 1.2.x pushed exactly one batch per run: 50 events every five minutes is
	 * 600 an hour, so a first-time export of a modest catalogue (800 products
	 * with variations, 300 customers, a week of orders) took the better part
	 * of a day to arrive — and on a traffic-driven WP-Cron, days. That is
	 * exactly what "the app never got all my data" looked like from the
	 * owner's side. The loop keeps the per-request caps (rows, bytes) and
	 * adds a wall-clock budget, so one run drains as much as the host's PHP
	 * limit tolerates and the next run picks up the rest — the queue is
	 * durable, so a run killed mid-loop loses nothing. 24 seconds stays
	 * under the 60-second cron lock and under the common 30–60 s
	 * max_execution_time with room for the pull phase.
	 */
	const PUSH_TIME_BUDGET_SECONDS = 24;

	public static function init() {
		// Every cron hook is bound unconditionally, before the `enabled` check
		// below and outside any per-entity toggle: each run_* method re-reads
		// the settings itself, so binding one behind a toggle would leave the
		// sweep unregistered for a request that loaded before a handshake
		// turned that toggle on — a schedule with nothing listening.
		add_action( POS_CONNECTOR_CRON_HOOK, array( __CLASS__, 'run' ) );
		add_action( POS_CONNECTOR_CRON_RESYNC_PRODUCTS, array( __CLASS__, 'run_resync_products' ) );
		add_action( POS_CONNECTOR_CRON_RESYNC_ORDERS, array( __CLASS__, 'run_resync_orders' ) );
		// The daily backfills: the customer book and the content mirror. They
		// cover accounts and posts created by an importer, a migration, or any
		// path where a hook never fired.
		add_action( POS_CONNECTOR_CRON_RESYNC_CUSTOMERS, array( __CLASS__, 'run_resync_customers' ) );
		add_action( POS_CONNECTOR_CRON_RESYNC_CONTENT, array( __CLASS__, 'run_resync_content' ) );

		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) ) {
			return;
		}

		if ( ! empty( $settings['sync_orders'] ) ) {
			// `woocommerce_new_order` fires for admin-created orders too, and
			// `checkout_order_processed` for the storefront path; both funnel
			// here, and the app's delivery-id dedup makes the overlap free.
			add_action( 'woocommerce_new_order', array( __CLASS__, 'on_order_changed' ), 20, 1 );
			add_action( 'woocommerce_checkout_order_processed', array( __CLASS__, 'on_order_changed' ), 20, 1 );
			add_action( 'woocommerce_order_status_changed', array( __CLASS__, 'on_order_status_changed' ), 20, 4 );
			add_action( 'woocommerce_order_refunded', array( __CLASS__, 'on_order_refunded' ), 20, 2 );
		}

		if ( ! empty( $settings['sync_products'] ) ) {
			add_action( 'woocommerce_update_product', array( __CLASS__, 'on_product_changed' ), 20, 1 );
			add_action( 'woocommerce_new_product', array( __CLASS__, 'on_product_changed' ), 20, 1 );
			// A variation saved on its own (from the product data metabox, or
			// by a bulk editor) fires no parent hook at all, so without this
			// a price changed on one variation never reached the app.
			add_action( 'woocommerce_new_product_variation', array( __CLASS__, 'on_product_changed' ), 20, 1 );
			add_action( 'woocommerce_update_product_variation', array( __CLASS__, 'on_product_changed' ), 20, 1 );
			// A variation deleted leaves the app holding a sellable row for
			// something the store no longer sells. Push the parent so the app
			// can reconcile the family.
			add_action( 'woocommerce_delete_product_variation', array( __CLASS__, 'on_variation_deleted' ), 20, 1 );
		}

		if ( ! empty( $settings['sync_customers'] ) ) {
			add_action( 'woocommerce_created_customer', array( __CLASS__, 'on_customer_changed' ), 20, 1 );
			add_action( 'woocommerce_update_customer', array( __CLASS__, 'on_customer_changed' ), 20, 1 );
		}

		// WordPress core content (posts, pages, media) belongs to the WP
		// Manager itself, not the WooCommerce «sync products» switch. Keeping
		// these hooks behind that commerce toggle made page edits silently
		// stop arriving whenever a store intentionally disabled catalogue
		// sync. Transitions cover posts/pages; attachments have their own add,
		// edit and delete hooks. Permanent deletion is distinct from trash:
		// trash remains visible with status=trash, deletion removes the mirror.
		add_action( 'transition_post_status', array( __CLASS__, 'on_post_status_changed' ), 20, 3 );
		add_action( 'add_attachment', array( __CLASS__, 'on_attachment_changed' ), 20, 1 );
		add_action( 'edit_attachment', array( __CLASS__, 'on_attachment_changed' ), 20, 1 );
		add_action( 'before_delete_post', array( __CLASS__, 'on_post_deleted' ), 20, 2 );
		add_action( 'delete_attachment', array( __CLASS__, 'on_attachment_deleted' ), 20, 2 );
	}

	// -----------------------------------------------------------------------
	// WordPress -> POS: observe and enqueue
	// -----------------------------------------------------------------------

	public static function on_order_changed( $order_id ) {
		self::enqueue_order( $order_id, 'order.created' );
	}

	/**
	 * A status change is sent as `order.updated` — except the transition into a
	 * paid state, which is sent as `order.created`.
	 *
	 * That is not a quirk: the app records an online order as a completed sale
	 * with its payment, so the event that *should* create it is the one where
	 * money actually moved, not the one where a pending cart row appeared.
	 */
	public static function on_order_status_changed( $order_id, $from, $to, $order = null ) {
		$paid_states = array( 'processing', 'completed' );
		$topic       = in_array( $to, $paid_states, true ) && ! in_array( $from, $paid_states, true )
			? 'order.created'
			: 'order.updated';
		self::enqueue_order( $order_id, $topic );
	}

	public static function on_order_refunded( $order_id, $refund_id ) {
		$refund = wc_get_order( $refund_id );
		if ( ! $refund ) {
			return;
		}
		self::safe_enqueue_callable(
			'refund.created',
			$refund_id,
			static function () use ( $refund, $order_id ) {
				return self::refund_payload( $refund, $order_id );
			}
		);
	}

	public static function on_product_changed( $product_id ) {
		if ( self::already_seen( 'product', $product_id ) ) {
			return;
		}
		$product = wc_get_product( $product_id );
		if ( ! $product ) {
			return;
		}
		self::safe_enqueue_callable(
			'product.updated',
			$product_id,
			static function () use ( $product ) {
				return self::product_payload( $product );
			}
		);

		// A variable product saved from the admin screen rewrites all of its
		// children, and WooCommerce fires no hook for the ones it changed.
		// Enqueue them here, because a variation's price is the one number
		// the app must not be stale about.
		if ( $product->is_type( 'variable' ) ) {
			self::enqueue_variations( $product->get_id() );
		}
	}

	/**
	 * A variation was deleted. Send its parent, not the variation.
	 *
	 * There is no payload to send for something that no longer exists, but the
	 * app is still mapping a sellable row to that variation id. A parent push
	 * is the signal to reconcile the family without a second event type.
	 */
	public static function on_variation_deleted( $variation_id ) {
		$variation = wc_get_product( $variation_id );
		$parent_id = $variation ? $variation->get_parent_id() : 0;
		if ( ! $parent_id ) {
			// The row is already gone; fall back to the post's parent.
			$post = get_post( $variation_id );
			$parent_id = $post ? (int) $post->post_parent : 0;
		}
		if ( ! $parent_id ) {
			return;
		}
		$parent = wc_get_product( $parent_id );
		if ( ! $parent ) {
			return;
		}
		self::safe_enqueue_callable(
			'product.updated',
			$parent_id,
			static function () use ( $parent ) {
				return self::product_payload( $parent );
			}
		);
	}

	public static function on_customer_changed( $customer_id ) {
		if ( self::already_seen( 'customer', $customer_id ) ) {
			return;
		}
		$customer = new WC_Customer( $customer_id );
		if ( ! $customer->get_id() ) {
			return;
		}
		self::safe_enqueue_callable(
			'customer.updated',
			$customer_id,
			static function () use ( $customer ) {
				return self::customer_payload( $customer );
			}
		);
	}

	// -----------------------------------------------------------------------
	// WordPress content: posts, pages, media
	// -----------------------------------------------------------------------

	/** The post types the content mirror cares about. Products are NOT here — they go through Woo hooks. */
	private static function mirrored_post_types() {
		return array( 'post', 'page' );
	}

	/**
	 * A post/page transitioned status (created, published, updated, trashed,
	 * restored). One hook covers all of them — `save_post` would need three
	 * save paths and miss trash/restore.
	 */
	public static function on_post_status_changed( $new_status, $old_status, $post ) {
		if ( ! $post || is_wp_error( $post ) ) {
			return;
		}
		if ( ! in_array( $post->post_type, self::mirrored_post_types(), true ) ) {
			return;
		}
		// Auto-drafts and revisions are noise, not content.
		if ( 'auto-draft' === $new_status || wp_is_post_revision( $post ) ) {
			return;
		}
		if ( self::already_seen( 'content:' . $post->post_type, $post->ID ) ) {
			return;
		}
		// Trash and restore both go as `content.updated`: the payload's own
		// `status` field carries 'trash'/'publish', and the queue's
		// (topic, remote_id) dedup means a trash followed by a restore in the
		// same sweep sends the latest state rather than two fighting events.
		self::safe_enqueue_callable(
			'content.updated',
			$post->post_type . ':' . $post->ID,
			static function () use ( $post ) {
				return self::content_payload( $post );
			}
		);
	}

	/** A media attachment was uploaded or its title/metadata was edited. */
	public static function on_attachment_changed( $attachment_id ) {
		if ( self::already_seen( 'content:attachment', $attachment_id ) ) {
			return;
		}
		$post = get_post( $attachment_id );
		if ( ! $post || 'attachment' !== $post->post_type ) {
			return;
		}
		self::safe_enqueue_callable(
			'content.updated',
			'attachment:' . $attachment_id,
			static function () use ( $post ) {
				return self::content_payload( $post );
			}
		);
	}

	/** A post/page is about to be permanently deleted (trash is an update). */
	public static function on_post_deleted( $post_id, $post ) {
		if ( ! $post || ! in_array( $post->post_type, self::mirrored_post_types(), true ) ) {
			return;
		}
		if ( self::already_seen( 'content:deleted:' . $post->post_type, $post_id ) ) {
			return;
		}
		POS_Connector_Queue::enqueue(
			'content.deleted',
			$post->post_type . ':' . $post_id,
			array(
				'id'   => (int) $post_id,
				'type' => $post->post_type,
			)
		);
	}

	/** An attachment is about to be permanently deleted. */
	public static function on_attachment_deleted( $attachment_id, $post = null ) {
		$post = $post ? $post : get_post( $attachment_id );
		if ( ! $post || 'attachment' !== $post->post_type ) {
			return;
		}
		if ( self::already_seen( 'content:deleted:attachment', $attachment_id ) ) {
			return;
		}
		POS_Connector_Queue::enqueue(
			'content.deleted',
			'attachment:' . $attachment_id,
			array(
				'id'   => (int) $attachment_id,
				'type' => 'attachment',
			)
		);
	}

	/**
	 * One post/page/attachment in the app's content-payload shape — the
	 * WordPress core REST fields the manager app reads.
	 */
	public static function content_payload( $post ) {
		$payload = array(
			'id'            => (int) $post->ID,
			'type'          => 'attachment' === $post->post_type ? 'attachment' : $post->post_type,
			'status'        => $post->post_status,
			'slug'          => $post->post_name,
			'link'          => get_permalink( $post->ID ) ?: '',
			'date'          => $post->post_date ? mysql2date( DATE_ATOM, $post->post_date ) : null,
			'date_modified' => $post->post_modified ? mysql2date( DATE_ATOM, $post->post_modified ) : null,
			'title'         => array(
				'rendered' => get_the_title( $post ),
				'raw'      => $post->post_title,
			),
			'author_name'   => get_the_author_meta( 'display_name', (int) $post->post_author ),
		);

		if ( 'attachment' === $post->post_type ) {
			$payload['source_url'] = wp_get_attachment_url( $post->ID ) ?: '';
			$payload['mime_type']  = $post->post_mime_type;
			$payload['media_type'] = strtok( (string) $post->post_mime_type, '/' ) ?: 'file';
			$payload['alt_text']   = get_post_meta( $post->ID, '_wp_attachment_image_alt', true );
			// Only present on the file this store received from a
			// `media_create` job (apply_media_create() stamps this meta
			// right after the sideload): what lets the app's Media Library
			// tell "the file I pushed just landed as attachment #123" apart
			// from every other attachment this same event fires for — a
			// site owner's own upload, or a later edit of either.
			$operation_id = get_post_meta( $post->ID, '_pos_operation_id', true );
			if ( $operation_id ) {
				$payload['operation_id'] = (string) $operation_id;
			}
		} else {
			// Excerpt/content are delivered raw so the manager's editor can
			// round-trip them; rendered HTML lives on the public site.
			$payload['content']     = $post->post_content;
			$payload['excerpt']     = $post->post_excerpt;
		}
		return $payload;
	}

	private static function already_seen( $kind, $id ) {
		$key = $kind . ':' . $id;
		if ( isset( self::$seen[ $key ] ) ) {
			return true;
		}
		self::$seen[ $key ] = true;
		return false;
	}

	private static function enqueue_order( $order_id, $topic ) {
		$order = wc_get_order( $order_id );
		if ( ! $order || $order->get_status() === 'trash' ) {
			return;
		}
		self::safe_enqueue_callable(
			$topic,
			$order_id,
			static function () use ( $order ) {
				return self::order_payload( $order );
			}
		);
	}

	/**
	 * Enqueue without letting sync errors abort a WooCommerce admin save.
	 *
	 * @return int Queue row id, or 0 when skipped or failed.
	 */
	private static function safe_enqueue( $topic, $remote_id, array $payload ) {
		try {
			return POS_Connector_Queue::enqueue( $topic, $remote_id, $payload );
		} catch ( \Throwable $e ) {
			POS_Connector_Log::error(
				'enqueue',
				sprintf(
					'%s:%s — %s',
					(string) $topic,
					(string) $remote_id,
					$e->getMessage()
				)
			);
			return 0;
		}
	}

	/** @return int Queue row id, or 0 when payload build or enqueue failed. */
	private static function safe_enqueue_callable( $topic, $remote_id, callable $build_payload ) {
		try {
			$payload = $build_payload();
			if ( ! is_array( $payload ) ) {
				return 0;
			}
			return self::safe_enqueue( $topic, $remote_id, $payload );
		} catch ( \Throwable $e ) {
			POS_Connector_Log::error(
				'enqueue',
				sprintf(
					'%s:%s — %s',
					(string) $topic,
					(string) $remote_id,
					$e->getMessage()
				)
			);
			return 0;
		}
	}

	/** Queue every child of a variable product as its own event. */
	private static function enqueue_variations( $parent_id ) {
		$children = wc_get_products(
			array(
				'parent' => $parent_id,
				'type'   => 'variation',
				'limit'  => -1,
				'return' => 'ids',
			)
		);
		foreach ( $children as $child_id ) {
			$child = wc_get_product( $child_id );
			if ( $child ) {
				self::safe_enqueue_callable(
					'product.updated',
					$child_id,
					static function () use ( $child ) {
						return self::product_payload( $child );
					}
				);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Payload builders — WooCommerce REST shapes, as the app already reads them
	// -----------------------------------------------------------------------

	/**
	 * One order, in WooCommerce's own REST shape.
	 *
	 * Every line carries `product_id` **and** `variation_id`, named exactly as
	 * WooCommerce's REST API names them. `WC_Order_Item_Product::get_product()`
	 * returns the variation when there is one, so a payload built from it alone
	 * put the variation's id in `product_id` — the opposite of what a webhook
	 * for the same order sends. See the class comment.
	 */
	public static function order_payload( $order ) {
		$items = array();
		foreach ( $order->get_items() as $item ) {
			if ( ! is_callable( array( $item, 'get_product_id' ) ) ) {
				continue;
			}
			$product      = $item->get_product();
			$product_id   = (int) $item->get_product_id();
			$variation_id = (int) $item->get_variation_id();

			// Some extensions build line items without setting the parent id.
			// Deriving it from the product keeps the two doors agreeing even
			// then, rather than emitting a variation with no parent at all.
			if ( $variation_id > 0 && $product_id <= 0 && $product ) {
				$product_id = (int) $product->get_parent_id();
			}

			$items[] = array(
				'id'           => $item->get_id(),
				'product_id'   => $product_id,
				'variation_id' => $variation_id,
				'name'         => $item->get_name(),
				'quantity'     => (int) $item->get_quantity(),
				'price'        => (string) $item->get_subtotal(),
				'total'        => (string) $item->get_total(),
				'subtotal'     => (string) $item->get_subtotal(),
				'total_tax'    => (string) $item->get_total_tax(),
				'sku'          => $product ? $product->get_sku() : '',
				// The parent's name, so the app can label a variation line the
				// way the customer saw it.
				'parent_name'  => $product && $product->get_parent_id() ? get_the_title( $product->get_parent_id() ) : '',
			);
		}

		return array(
			'id'             => $order->get_id(),
			'number'         => $order->get_order_number(),
			'status'         => $order->get_status(),
			'currency'       => $order->get_currency(),
			'total'          => (string) $order->get_total(),
			'total_tax'      => (string) $order->get_total_tax(),
			'shipping_total' => (string) $order->get_shipping_total(),
			'discount_total' => (string) $order->get_discount_total(),
			'payment_method' => $order->get_payment_method(),
			'date_created'   => $order->get_date_created() ? $order->get_date_created()->date( DATE_ATOM ) : null,
			'date_paid'      => $order->get_date_paid() ? $order->get_date_paid()->date( DATE_ATOM ) : null,
			'date_modified'  => $order->get_date_modified() ? $order->get_date_modified()->date( DATE_ATOM ) : null,
			'customer_id'    => $order->get_customer_id(),
			'billing'        => array(
				'first_name' => $order->get_billing_first_name(),
				'last_name'  => $order->get_billing_last_name(),
				'phone'      => $order->get_billing_phone(),
				'email'      => $order->get_billing_email(),
				'company'    => $order->get_billing_company(),
				'address_1'  => $order->get_billing_address_1(),
				'city'       => $order->get_billing_city(),
			),
			'line_items'     => $items,
		);
	}

	public static function refund_payload( $refund, $parent_order_id ) {
		$items = array();
		foreach ( $refund->get_items() as $item ) {
			$product = $item->get_product();
			$items[] = array(
				'id'           => $item->get_id(),
				'product_id'   => is_callable( array( $item, 'get_product_id' ) ) ? (int) $item->get_product_id() : ( $product ? $product->get_id() : 0 ),
				'variation_id' => is_callable( array( $item, 'get_variation_id' ) ) ? (int) $item->get_variation_id() : 0,
				'name'         => $item->get_name(),
				// WooCommerce stores refunded quantities and totals as negative
				// numbers; the app expects the magnitude, so they are made
				// positive here rather than in three places on the other side.
				'quantity'     => abs( (int) $item->get_quantity() ),
				'total'        => (string) abs( (float) $item->get_total() ),
			);
		}

		return array(
			'id'           => $refund->get_id(),
			'order_id'     => (int) $parent_order_id,
			'parent_id'    => (int) $parent_order_id,
			'amount'       => (string) abs( (float) $refund->get_amount() ),
			'reason'       => $refund->get_reason(),
			'date_created' => $refund->get_date_created() ? $refund->get_date_created()->date( DATE_ATOM ) : null,
			'line_items'   => $items,
		);
	}

	/**
	 * One product or variation's full identity, enough for the app to build an
	 * `items` row (retail) or a `menu_items` row (F&B) from it.
	 *
	 * A variable product's children are NOT embedded here — get_variation_ids
	 * during an export async-calls get_product for each child, so embedding
	 * them in the parent payload would (a) risk a timeout for a product with
	 * 100 SKU and (b) produce stale children when `woocommerce_update_product`
	 * fires only for the parent. Instead, the export loop enqueues a separate
	 * `product.updated` event for each child, and `product.updated` on a
	 * variable parent only carries the parent-level fields (name, sku,
	 * attributes) the app already needs to create `variant_parent` items.
	 */
		private static function product_taxonomies() {
			$taxonomies = array();
			foreach ( get_object_taxonomies( 'product', 'objects' ) as $taxonomy => $object ) {
				if ( in_array( $taxonomy, array( 'category', 'post_tag' ), true ) ) {
					continue;
				}
				if ( 'product_cat' === $taxonomy || 'product_tag' === $taxonomy || 0 === strpos( $taxonomy, 'pa_' ) || in_array( 'product', (array) $object->object_type, true ) ) {
					$taxonomies[ $taxonomy ] = $object;
				}
			}
			return $taxonomies;
		}

		private static function term_payload( $term ) {
			return array(
				'id'          => (int) $term->term_id,
				'taxonomy'    => $term->taxonomy,
				'parent'      => (int) $term->parent,
				'name'        => $term->name,
				'slug'        => $term->slug,
				'description' => $term->description,
				'count'       => (int) $term->count,
				'menu_order'  => (int) get_term_meta( $term->term_id, 'order', true ),
			);
		}

		private static function product_terms_payload( $post_id ) {
			$terms_by_taxonomy = array();
			foreach ( array_keys( self::product_taxonomies() ) as $taxonomy ) {
				$terms = wp_get_post_terms( $post_id, $taxonomy );
				if ( is_wp_error( $terms ) || empty( $terms ) ) {
					continue;
				}
				$terms_by_taxonomy[ $taxonomy ] = array_map( array( __CLASS__, 'term_payload' ), $terms );
			}
			return $terms_by_taxonomy;
		}

		private static function enqueue_taxonomy_snapshot() {
			$total = 0;
			foreach ( array_keys( self::product_taxonomies() ) as $taxonomy ) {
				$terms = get_terms(
					array(
						'taxonomy'   => $taxonomy,
						'hide_empty' => false,
					)
				);
				if ( is_wp_error( $terms ) ) {
					continue;
				}
				$payload_terms = array_map( array( __CLASS__, 'term_payload' ), $terms );
				$total += count( $payload_terms );
				POS_Connector_Queue::enqueue(
					'catalogue.taxonomy_terms',
					$taxonomy,
					array(
						'id'       => $taxonomy,
						'taxonomy' => $taxonomy,
						'terms'    => $payload_terms,
					)
				);
			}
			return $total;
		}

	/**
	 * Map one raw WooCommerce attribute entry to the REST-shaped array the app reads.
	 *
	 * Some stores (legacy data, imports) return plain strings or slug => string
	 * pairs instead of WC_Product_Attribute objects — product 13199 on zaniziba.com
	 * was one example of the fatal that caused when `get_id()` ran on a string.
	 *
	 * @param string|int $key  Attribute key from get_attributes().
	 * @param mixed      $attr Value from get_attributes().
	 * @return array|null REST-shaped attribute, or null when the entry is unusable.
	 */
	public static function rest_attribute_from_raw( $key, $attr ) {
		if ( is_array( $attr ) ) {
			return array(
				'id'        => 0,
				'name'      => isset( $attr['name'] ) ? (string) $attr['name'] : '',
				'position'  => 0,
				'visible'   => true,
				'variation' => true,
				'options'   => isset( $attr['value'] ) ? array_map( 'trim', explode( ',', (string) $attr['value'] ) ) : array(),
			);
		}

		if ( is_string( $attr ) ) {
			$slug = is_string( $key ) ? str_replace( 'attribute_', '', $key ) : '';
			$name = $slug && function_exists( 'wc_attribute_label' )
				? wc_attribute_label( $slug )
				: ( is_string( $key ) ? (string) $key : '' );
			return array(
				'id'        => 0,
				'name'      => $name,
				'position'  => 0,
				'visible'   => true,
				'variation' => true,
				'options'   => array_map( 'trim', explode( ',', $attr ) ),
			);
		}

		if ( is_object( $attr ) && method_exists( $attr, 'get_id' ) ) {
			return array(
				'id'        => (int) $attr->get_id(),
				'name'      => $attr->get_name(),
				'position'  => (int) $attr->get_position(),
				'visible'   => (bool) $attr->get_visible(),
				'variation' => (bool) $attr->get_variation(),
				'options'   => $attr->get_options(),
			);
		}

		return null;
	}

		public static function product_payload( $product ) {
		$type         = $product->get_type();
		$parent_id    = (int) $product->get_parent_id();
		$description  = $product->get_description();
		$short_desc   = $product->get_short_description();
		$stock_status = $product->get_stock_status();

		// Attributes: the named options a variable product defines (parent) and
		// the concrete selections a variation picks (child). Standard shapes
		// from WooCommerce's own REST API, which the app's TS types mirror.
		$attributes = array();
		foreach ( $product->get_attributes() as $attr_key => $attr ) {
			$entry = self::rest_attribute_from_raw( $attr_key, $attr );
			if ( null !== $entry ) {
				$attributes[] = $entry;
			}
		}

		// Categories: a flat array of {id, name, slug} triples. A variation
		// carries no product_cat of its own — WooCommerce files the taxonomy
		// on the parent — so a variation reads its parent's terms. Without
		// this, every variation arrived with an empty array and the app's
		// «دسته‌بندی» column and taxonomy mirror showed parents sorted into
		// categories and all of their children in none.
		$term_post_id = $product->get_id();
		if ( 'variation' === $type && $parent_id ) {
			$term_post_id = $parent_id;
		}
		$categories = array();
		foreach ( wp_get_post_terms( $term_post_id, 'product_cat' ) as $term ) {
			$categories[] = array(
				'id'   => $term->term_id,
				'name' => $term->name,
				'slug' => $term->slug,
			);
		}

		// Tags, so the app's taxonomy mirror is not half a tree — read from
		// the parent for a variation, for the same reason as the categories.
		$tags = array();
		foreach ( wp_get_post_terms( $term_post_id, 'product_tag' ) as $term ) {
			$tags[] = array(
				'id'   => $term->term_id,
				'name' => $term->name,
				'slug' => $term->slug,
			);
		}

			$all_terms = self::product_terms_payload( $term_post_id );

			// Images: the main image plus gallery, each as {id, src, alt}.
			$images   = array();
		$image_id = $product->get_image_id();
		if ( $image_id ) {
			$src      = wp_get_attachment_url( $image_id );
			$alt      = get_post_meta( $image_id, '_wp_attachment_image_alt', true );
			$images[] = array( 'id' => $image_id, 'src' => $src ? $src : '', 'alt' => $alt ? $alt : '', 'position' => 0 );
		}
		foreach ( $product->get_gallery_image_ids() as $idx => $gallery_id ) {
			$src    = wp_get_attachment_url( $gallery_id );
			$alt    = get_post_meta( $gallery_id, '_wp_attachment_image_alt', true );
			$images[] = array( 'id' => $gallery_id, 'src' => $src ? $src : '', 'alt' => $alt ? $alt : '', 'position' => $idx + 1 );
		}

		// Variation-specific fields, only present when $type === 'variation'.
		$variation_attributes = array();
		if ( 'variation' === $type ) {
			foreach ( $product->get_variation_attributes() as $key => $value ) {
				$variation_attributes[] = array(
					'name'   => wc_attribute_label( str_replace( 'attribute_', '', $key ) ),
					// An empty value means "any of them" in WooCommerce's own
					// UI; sending it as a blank attribute would make the app
					// name a variation «تی‌شرت • رنگ: ».
					'option' => '' === $value ? __( 'هر کدام', 'pos-accounting-connector' ) : $value,
				);
			}
		}

		$payload = array(
			'id'               => $product->get_id(),
			'type'             => $type,
			'name'             => $product->get_name(),
			'sku'              => $product->get_sku(),
			'price'            => (string) $product->get_price(),
			'regular_price'    => (string) $product->get_regular_price(),
			'sale_price'       => (string) $product->get_sale_price(),
			'stock_quantity'   => $product->get_stock_quantity(),
			'manage_stock'     => (bool) $product->get_manage_stock(),
			'stock_status'     => $stock_status,
			'status'           => $product->get_status(),
			'description'      => $description,
			'short_description' => $short_desc,
			'permalink'        => get_permalink( $product->get_id() ),
			'menu_order'       => (int) $product->get_menu_order(),
			'date_modified'    => $product->get_date_modified() ? $product->get_date_modified()->date( DATE_ATOM ) : null,
			'attributes'       => $attributes,
				'categories'       => $categories,
				'tags'             => $tags,
				'terms'            => $all_terms,
				'images'           => $images,
		);

		if ( $parent_id ) {
			$payload['parent_id'] = $parent_id;
		}

		if ( 'variation' === $type && ! empty( $variation_attributes ) ) {
			$payload['variation_attributes'] = $variation_attributes;
		}

		// A variable product's children, as ids. The app uses them only to
		// know how many variations to expect — the children themselves arrive
		// as their own events.
		if ( 'variable' === $type ) {
			$payload['variation_ids'] = array_map( 'intval', $product->get_children() );
		}

		return $payload;
	}

	public static function customer_payload( $customer ) {
		return array(
			'id'         => $customer->get_id(),
			'email'      => $customer->get_email(),
			'first_name' => $customer->get_first_name(),
			'last_name'  => $customer->get_last_name(),
			'billing'    => array(
				'phone'     => $customer->get_billing_phone(),
				'address_1' => $customer->get_billing_address_1(),
				'city'      => $customer->get_billing_city(),
			),
		);
	}

	// -----------------------------------------------------------------------
	// The scheduled runs
	// -----------------------------------------------------------------------

	/**
	 * The fast lane: say hello, push what is queued, pull and apply what is
	 * waiting.
	 *
	 * Ordered that way deliberately. The handshake refreshes the settings the
	 * push then honours; pushing before pulling means a stock level the app
	 * computes is computed from sales it already knows about, rather than from
	 * a picture one cycle out of date.
	 *
	 * Since 1.3.0 both pushes run in a loop under a wall-clock budget, and a
	 * short second push runs *after* the pull: an export job the pull just
	 * applied has filled the queue with the entire catalogue, and making that
	 * wait for the next tick is what turned a five-minute initial sync into a
	 * day-long drip.
	 */
	private static function record_server_paused() {
		pos_connector_update_settings(
			array(
				'last_ok_at'     => current_time( 'mysql', true ),
				'last_error'     => __( 'همگام‌سازی از سمت پنل متوقف شده است', 'pos-accounting-connector' ),
				'last_run_stats' => array( 'paused' => true, 'at' => current_time( 'mysql', true ) ),
			)
		);
		POS_Connector_Log::info( 'paused', 'همگام‌سازی از سمت پنل متوقف شده است' );
	}

	/**
	 * Freshly ask the app whether data movement is allowed. Used by the scheduled
	 * backfills and manual export buttons before they read a large local data set
	 * into the plugin queue; handshake/ping/health still works while paused.
	 */
	public static function server_allows_data_movement() {
		$client = POS_Connector_Client::from_settings();
		if ( ! $client ) {
			POS_Connector_Log::error( 'handshake', 'not_configured' );
			return false;
		}
		$handshake = self::handshake( $client );
		if ( ! $handshake['ok'] ) {
			pos_connector_update_settings( array( 'last_error' => POS_Connector_Client::explain( $handshake['error'] ) ) );
			POS_Connector_Log::error( 'handshake', $handshake['error'] );
			return false;
		}
		if ( isset( $handshake['data']['serverStatus'] ) && 'paused' === $handshake['data']['serverStatus'] ) {
			self::record_server_paused();
			return 'paused';
		}
		return true;
	}

	public static function run() {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) ) {
			return;
		}

		$client = POS_Connector_Client::from_settings();
		if ( ! $client ) {
			POS_Connector_Log::error( 'run', 'not_configured' );
			return;
		}

		$handshake = self::handshake( $client );
		if ( ! $handshake['ok'] ) {
			pos_connector_update_settings( array( 'last_error' => POS_Connector_Client::explain( $handshake['error'] ) ) );
			POS_Connector_Log::error( 'handshake', $handshake['error'] );
			return;
		}

			if ( isset( $handshake['data']['serverStatus'] ) && 'paused' === $handshake['data']['serverStatus'] ) {
				self::record_server_paused();
				return array( 'paused' => true, 'pushed' => 0, 'applied' => 0 );
			}

			$started = microtime( true );
			$pushed  = self::push_queue_until( $client, $started );
		$applied = self::pull_jobs( $client );
		// Whatever budget is left ships the events a just-applied export job
		// queued, so «همگام‌سازی محصولات» starts producing rows in the same
		// run the plugin accepted the job.
		$pushed += self::push_queue_until( $client, $started );

		$stats = array(
			'at'      => current_time( 'mysql', true ),
			'pushed'  => $pushed,
			'applied' => $applied,
		);

		pos_connector_update_settings(
			array(
				'last_ok_at'     => current_time( 'mysql', true ),
				'last_error'     => '',
				'last_run_stats' => $stats,
			)
		);
		POS_Connector_Queue::prune();
		POS_Connector_Log::prune();

		return $stats;
	}

	/**
	 * Push batches until the queue is empty, a batch stops making progress, or
	 * the run's time budget runs out.
	 *
	 * `push_queue` returns 0 both when there is nothing left and when the app
	 * could not be reached — in both cases looping would only hammer the same
	 * failure, so 0 is where this stops. A batch that delivered *some* rows
	 * (the app rejects events one by one, not wholesale) keeps the loop going:
	 * those are the backlog minutes of a first sync.
	 */
	private static function push_queue_until( POS_Connector_Client $client, $started_at ) {
		$total = 0;
		do {
			$sent = self::push_queue( $client );
			$total += $sent;
		} while (
			$sent > 0
			&& ( microtime( true ) - $started_at ) < self::PUSH_TIME_BUDGET_SECONDS
		);
		return $total;
	}

	/**
	 * The catalogue sweep: queue the entire catalogue as ordinary product
	 * events, then run the fast lane so they start going out immediately
	 * rather than waiting for the next tick.
	 */
	public static function run_resync_products() {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) || empty( $settings['sync_products'] ) ) {
			return;
		}
		$movement = self::server_allows_data_movement();
		if ( true !== $movement ) {
			return;
		}
		$settings = pos_connector_settings();
		if ( empty( $settings['sync_products'] ) ) {
			return;
		}
		self::export_products();
		pos_connector_update_settings( array( 'last_products_sweep_at' => current_time( 'mysql', true ) ) );
		self::run();
	}

	/**
	 * The order sweep: queue every order changed in the lookback window.
	 *
	 * This is the backstop that makes a missed hook survivable. A sale that
	 * never fired `woocommerce_new_order` — a plugin conflict, a fatal during
	 * checkout, an order created by an importer — is invisible until something
	 * goes looking for it, and this is the something.
	 */
	public static function run_resync_orders() {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) || empty( $settings['sync_orders'] ) ) {
			return;
		}
		$movement = self::server_allows_data_movement();
		if ( true !== $movement ) {
			return;
		}
		$settings = pos_connector_settings();
		if ( empty( $settings['sync_orders'] ) ) {
			return;
		}
		self::export_orders( (int) $settings['resync_orders_days'] );
		pos_connector_update_settings( array( 'last_orders_sweep_at' => current_time( 'mysql', true ) ) );
		self::run();
	}

	/**
	 * Introduce this site and take back the connection's current settings.
	 *
	 * The sync toggles live in the accounting dashboard, so this is how a
	 * change made there reaches WordPress — nobody has to configure the same
	 * switch twice, and the two sides cannot disagree about what is being
	 * synced.
	 */
		private static function capabilities() {
			return array(
				'eventTypes' => array(
					'order.created',
					'order.updated',
					'refund.created',
					'product.updated',
					'customer.updated',
					'content.updated',
					'content.deleted',
					'catalogue.taxonomy_terms',
					'catalogue.sync_completed',
					'orders.sync_completed',
					'customers.sync_completed',
					'content.sync_completed',
				),
				'jobTypes'   => array(
					'stock',
					'price',
					'product_update',
					'order_status',
					'refund_create',
					'catalogue_export',
					'customer_export',
					'orders_export',
					'content_export',
					'post_upsert',
					'media_create',
				),
			);
		}

		private static function telemetry() {
			$settings = pos_connector_settings();
			$counts   = POS_Connector_Queue::counts();
			return array(
				'pluginVersion'       => POS_CONNECTOR_VERSION,
				'siteUrl'             => home_url(),
				'wordpressVersion'    => get_bloginfo( 'version' ),
				'woocommerceVersion'  => defined( 'WC_VERSION' ) ? WC_VERSION : null,
				'phpVersion'          => PHP_VERSION,
				'lastSuccessfulRun'   => $settings['last_ok_at'],
				'lastLocalError'      => $settings['last_error'],
				'localQueuePending'   => (int) $counts['pending'],
				'localQueueDeferred'  => (int) POS_Connector_Queue::deferred_count(),
				'localQueueFailed'    => (int) $counts['failed'],
				'lastProductsSweep'   => $settings['last_products_sweep_at'],
				'lastOrdersSweep'     => $settings['last_orders_sweep_at'],
				'lastCustomersSweep'  => $settings['last_customers_sweep_at'],
				'lastContentSweep'    => $settings['last_content_sweep_at'],
				'nextCron'            => array(
					'fast'      => wp_next_scheduled( POS_CONNECTOR_CRON_HOOK ),
					'orders'    => wp_next_scheduled( POS_CONNECTOR_CRON_RESYNC_ORDERS ),
					'catalogue' => wp_next_scheduled( POS_CONNECTOR_CRON_RESYNC_PRODUCTS ),
					'customers' => wp_next_scheduled( POS_CONNECTOR_CRON_RESYNC_CUSTOMERS ),
					'content'   => wp_next_scheduled( POS_CONNECTOR_CRON_RESYNC_CONTENT ),
				),
				'schedules'          => array(
					'orders'    => $settings['resync_orders_schedule'],
					'catalogue' => $settings['resync_products_schedule'],
					'lookback'  => (int) $settings['resync_orders_days'],
				),
			);
		}

		public static function handshake( POS_Connector_Client $client ) {
			$response = $client->post(
				'/api/integrations/wordpress/handshake',
				array(
					'siteUrl'         => home_url(),
					'pluginVersion'   => POS_CONNECTOR_VERSION,
					'protocolVersion' => 2,
					'capabilities'    => self::capabilities(),
					'telemetry'       => self::telemetry(),
				)
			);
		if ( ! $response['ok'] ) {
			return $response;
		}

		$connection = isset( $response['data']['connection'] ) ? $response['data']['connection'] : array();
		if ( $connection ) {
			pos_connector_update_settings(
				array(
					'sync_orders'    => ! empty( $connection['syncOrders'] ),
					'sync_products'  => ! empty( $connection['syncProducts'] ),
					'sync_customers' => ! empty( $connection['syncCustomers'] ),
					'apply_stock'    => ! empty( $connection['pushStock'] ),
					'apply_prices'   => ! empty( $connection['pushPrices'] ),
				)
			);
		}
		return $response;
	}

	/**
	 * Send queued events in batches, marking each row by what the app said
	 * about it. Returns how many were delivered.
	 */
	public static function push_queue( POS_Connector_Client $client ) {
		$rows = POS_Connector_Queue::due( self::PUSH_BATCH_ROWS );
		if ( empty( $rows ) ) {
			return 0;
		}

		$events = array();
		$by_id  = array();
		$bytes  = 0;
		foreach ( $rows as $row ) {
			// The app refuses a body over 2 MB outright (413 payload_too_large),
			// and it refuses the *whole* batch — so a fixed count of 50 rows was
			// only safe while payloads were small. A page's raw HTML or a long
			// product description makes fifty of them megabytes, and because
			// `due()` is ordered by id the same oversized batch was rebuilt on
			// every run, failed identically, and blocked every event behind it.
			// Fill the batch by size instead, always sending at least one row so
			// a single oversized event is reported against itself (and backs off)
			// rather than jamming the queue behind it.
			$size = strlen( (string) $row['payload'] ) + 128;
			if ( $events && $bytes + $size > self::PUSH_BATCH_BYTES ) {
				break;
			}
			$bytes   += $size;
			$events[] = array(
				'topic'      => $row['topic'],
				'deliveryId' => $row['delivery_id'],
				'payload'    => json_decode( $row['payload'], true ),
			);
			$by_id[ $row['delivery_id'] ] = (int) $row['id'];
		}

		$response = $client->post( '/api/integrations/wordpress/events', array( 'events' => $events ) );
		if ( ! $response['ok'] ) {
			// The whole batch failed to be *delivered* — not to be applied — so
			// every row keeps its place in the queue and gets another attempt.
			foreach ( $by_id as $id ) {
				POS_Connector_Queue::mark_failed( $id, $response['error'] );
			}
			POS_Connector_Log::error( 'push', $response['error'] );
			return 0;
		}

		$sent   = array();
		$failed = 0;
		foreach ( (array) ( isset( $response['data']['results'] ) ? $response['data']['results'] : array() ) as $result ) {
			$delivery_id = isset( $result['deliveryId'] ) ? $result['deliveryId'] : '';
			if ( ! isset( $by_id[ $delivery_id ] ) ) {
				continue;
			}
			// "duplicate" is a success: the app already has this event, which is
			// exactly what a retry after a timeout is supposed to discover.
				if ( isset( $result['status'] ) && in_array( $result['status'], array( 'processed', 'duplicate', 'deferred' ), true ) ) {
				$sent[] = $by_id[ $delivery_id ];
			} else {
				++$failed;
				POS_Connector_Queue::mark_failed( $by_id[ $delivery_id ], isset( $result['error'] ) ? $result['error'] : 'rejected' );
			}
		}

		POS_Connector_Queue::mark_sent( $sent );
		POS_Connector_Log::info( 'push', sprintf( 'ارسال‌شده: %d، ناموفق: %d', count( $sent ), $failed ) );
		return count( $sent );
	}

	/**
	 * Lease jobs from the app, apply each to WooCommerce, and report back.
	 * Returns how many were applied.
	 */
	public static function pull_jobs( POS_Connector_Client $client ) {
		$response = $client->post( '/api/integrations/wordpress/jobs' );
		if ( ! $response['ok'] ) {
			POS_Connector_Log::error( 'pull', $response['error'] );
			return 0;
		}

		$jobs = isset( $response['data']['jobs'] ) ? (array) $response['data']['jobs'] : array();
		if ( empty( $jobs ) ) {
			return 0;
		}

		$results = array();
		$applied = 0;
		foreach ( $jobs as $job ) {
			$job    = (array) $job;
			$job_id = isset( $job['id'] ) ? (string) $job['id'] : '';
			$type   = isset( $job['type'] ) ? (string) $job['type'] : 'unknown';
			if ( '' === $job_id ) {
				// Nothing to ack against, so applying it could only produce
				// work the app would lease out again.
				POS_Connector_Log::error( 'job:' . $type, 'missing_job_id' );
				continue;
			}
			// `Throwable`, not `Exception`: apply_job calls into WooCommerce and
			// WordPress, where a deleted product or a plugin conflict raises a
			// PHP `Error` — which `catch ( Exception )` does not catch. One such
			// job aborted the whole run *before the ack below*, so every job
			// already applied above it was never reported done, its lease
			// expired, and it was applied a second time on the next run. For
			// `refund_create` that is a second refund against the same order.
			try {
				self::apply_job( $job );
				$results[] = array(
					'id'     => $job_id,
					'status' => 'done',
				);
				++$applied;
			} catch ( Throwable $e ) {
				$results[] = array(
					'id'     => $job_id,
					'status' => 'failed',
					'error'  => $e->getMessage(),
				);
				POS_Connector_Log::error( 'job:' . $type, $e->getMessage() );
			}
		}

		if ( ! empty( $results ) ) {
			$ack = $client->post( '/api/integrations/wordpress/jobs/ack', array( 'results' => $results ) );
			if ( ! $ack['ok'] ) {
				// Worth its own log line: the work landed in WooCommerce but the
				// app still holds the jobs as pending, so they will be leased
				// again — the one state where a re-apply is not a no-op.
				POS_Connector_Log::error( 'ack', $ack['error'] );
			}
		}
		POS_Connector_Log::info( 'pull', sprintf( 'کار دریافتی: %d', count( $jobs ) ) );
		return $applied;
	}

	/**
	 * Apply one job.
	 *
	 * Throws on failure rather than returning a flag: the caller turns a thrown
	 * message into the `failed` ack, and a job that half-applied must not be
	 * reported as done.
	 */
	private static function apply_job( array $job ) {
		$settings = pos_connector_settings();
		$type     = isset( $job['type'] ) ? $job['type'] : '';
		$payload  = isset( $job['payload'] ) && is_array( $job['payload'] ) ? $job['payload'] : array();
		// A variation's updates must be applied to the variation, which
		// `wc_get_product()` also returns for a variation id — but the parent
		// id is sent precisely so a store with an unusual product class can be
		// sure which object it was given.
		$remote   = isset( $job['remoteId'] ) ? (int) $job['remoteId'] : 0;
		$parent   = isset( $job['parentRemoteId'] ) ? (int) $job['parentRemoteId'] : 0;

		switch ( $type ) {
			case 'stock':
				if ( empty( $settings['apply_stock'] ) ) {
					// The owner switched this off on the accounting side. Acking
					// as done rather than failed is right: nothing went wrong,
					// and failing would retry it six times before dead-lettering.
					return;
				}
				$product = self::product_for_job( $remote, $parent );
				if ( ! array_key_exists( 'stock_quantity', $payload ) ) {
					throw new Exception( 'missing_stock_quantity' );
				}
				$product->set_manage_stock( true );
				$product->set_stock_quantity( (int) $payload['stock_quantity'] );
				$product->save();
				return;

			case 'price':
				if ( empty( $settings['apply_prices'] ) ) {
					return;
				}
				$product = self::product_for_job( $remote, $parent );
				if ( ! array_key_exists( 'regular_price', $payload ) ) {
					throw new Exception( 'missing_regular_price' );
				}
				$product->set_regular_price( (string) $payload['regular_price'] );
				// A sale price above the new regular price would silently keep
				// the old, lower number in front of customers.
				if ( '' !== $product->get_sale_price() && (float) $product->get_sale_price() > (float) $payload['regular_price'] ) {
					$product->set_sale_price( '' );
				}
				$product->save();
				return;

			case 'product_update':
				// A whole-field update from the accounting dashboard. The field
				// list was validated on the app side; here it is applied field
				// by field so an unknown key cannot be written blind.
				$product = self::product_for_job( $remote, $parent );
				$allowed = array(
					'name'              => 'set_name',
					'regular_price'     => 'set_regular_price',
					'sale_price'        => 'set_sale_price',
					'stock_quantity'    => 'set_stock_quantity',
					'manage_stock'      => 'set_manage_stock',
					'status'            => 'set_status',
					'description'       => 'set_description',
					'short_description' => 'set_short_description',
				);
				$applied = false;
				foreach ( $allowed as $field => $setter ) {
					if ( ! array_key_exists( $field, $payload ) ) {
						continue;
					}
					$value = $payload[ $field ];
					if ( 'manage_stock' === $field ) {
						$value = (bool) $value;
					} elseif ( 'stock_quantity' === $field ) {
						$value = (int) $value;
					} else {
						$value = (string) $value;
					}
					$product->{$setter}( $value );
					$applied = true;
				}
				if ( ! $applied ) {
					throw new Exception( 'empty_product_update' );
				}
				$product->save();
				return;

			case 'order_status':
				$order = wc_get_order( $remote );
				if ( ! $order ) {
					throw new Exception( 'order_not_found' );
				}
				if ( ! isset( $payload['status'] ) ) {
					throw new Exception( 'missing_status' );
				}
				// `set_status` does not persist; without an explicit save the
				// change would be acked and then vanish.
				$order->set_status( (string) $payload['status'] );
				$order->save();
				return;

				case 'refund_create':
					$order_remote = isset( $payload['__orderRemoteId'] ) ? (int) $payload['__orderRemoteId'] : $remote;
					$order = wc_get_order( $order_remote );
					if ( ! $order ) {
						throw new Exception( 'order_not_found' );
					}
					if ( ! isset( $payload['amount'] ) ) {
						throw new Exception( 'missing_amount' );
					}
					$operation_id = isset( $payload['__operationId'] ) ? (string) $payload['__operationId'] : '';
					if ( '' === $operation_id ) {
						throw new Exception( 'operation_id_missing_for_non_idempotent_refund' );
					}
					if ( '' !== $operation_id ) {
						foreach ( $order->get_refunds() as $existing_refund ) {
							if ( $existing_refund && $existing_refund->get_meta( '_pos_operation_id', true ) === $operation_id ) {
								return;
							}
						}
					}
					// `api_refund` is deliberately forced false: this app records
					// that a refund was agreed, it does not move money through a
					// payment gateway. Crediting a card is the store's business.
					$refund = wc_create_refund(
					array(
						'amount'     => (string) $payload['amount'],
						'reason'     => isset( $payload['reason'] ) ? (string) $payload['reason'] : '',
							'order_id'   => $order_remote,
						'refund_id'  => 0,
						'restock_items' => true,
					)
				);
					if ( is_wp_error( $refund ) ) {
						throw new Exception( $refund->get_error_message() );
					}
					if ( '' !== $operation_id && $refund ) {
						$refund->update_meta_data( '_pos_operation_id', $operation_id );
						$refund->save();
					}
					return;

			case 'catalogue_export':
				self::export_products();
				return;

			case 'customer_export':
				self::export_customers();
				return;

			case 'orders_export':
				self::export_orders( isset( $payload['sinceDays'] ) && $payload['sinceDays'] ? (int) $payload['sinceDays'] : (int) $settings['resync_orders_days'] );
				return;

			case 'content_export':
				self::export_content();
				return;

			case 'post_upsert':
				self::apply_post_upsert( $payload );
				return;

			case 'media_create':
				self::apply_media_create( $remote, $payload );
				return;

				default:
					// Capability negotiation should prevent this. If it still happens,
					// fail the job loudly rather than ACK/drop an operation the plugin
					// does not understand.
					throw new Exception( 'plugin_version_unsupported:' . $type );
			}
		}

	/**
	 * Apply a create/update to a WordPress post or page.
	 *
	 * Field-by-field, the same closed-list discipline `product_update` uses:
	 * a payload key this plugin does not recognise is not written blind.
	 * The status is validated against WordPress's own set so a mis-sent value
	 * cannot push a page into an unknown state.
	 */
		private static function post_id_by_operation( $operation_id, $type ) {
			if ( '' === $operation_id ) {
				return 0;
			}
			$found = get_posts(
				array(
					'post_type'      => $type,
					'post_status'    => 'attachment' === $type ? 'inherit' : array( 'publish', 'draft', 'pending', 'private', 'future', 'trash' ),
					'posts_per_page' => 1,
					'fields'         => 'ids',
					'meta_key'       => '_pos_operation_id', // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
					'meta_value'     => $operation_id, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_value
				)
			);
			return empty( $found ) ? 0 : (int) $found[0];
		}

		private static function apply_post_upsert( array $payload ) {
			$type         = isset( $payload['post_type'] ) && 'page' === $payload['post_type'] ? 'page' : 'post';
			$id           = isset( $payload['id'] ) ? (int) $payload['id'] : 0;
			$operation_id = isset( $payload['__operationId'] ) ? sanitize_text_field( (string) $payload['__operationId'] ) : '';
			if ( $id <= 0 && '' === $operation_id ) {
				throw new Exception( 'operation_id_missing_for_non_idempotent_post_create' );
			}
			if ( $id <= 0 && '' !== $operation_id ) {
				$existing_by_operation = self::post_id_by_operation( $operation_id, $type );
				if ( $existing_by_operation > 0 ) {
					return;
				}
			}

			$allowed_status = array( 'publish', 'draft', 'pending', 'private', 'future' );
		$data           = array();
		if ( isset( $payload['title'] ) ) {
			$data['post_title'] = wp_kses_post( (string) $payload['title'] );
		}
		if ( isset( $payload['content'] ) ) {
			// Content is the owner's own HTML from their own accounting app;
			// wp_kses_post keeps the same tag set the post editor allows.
			$data['post_content'] = wp_kses_post( (string) $payload['content'] );
		}
		if ( isset( $payload['excerpt'] ) ) {
			$data['post_excerpt'] = sanitize_text_field( (string) $payload['excerpt'] );
		}
		if ( isset( $payload['slug'] ) ) {
			$data['post_name'] = sanitize_title( (string) $payload['slug'] );
		}
		if ( isset( $payload['status'] ) ) {
			$status = (string) $payload['status'];
			if ( ! in_array( $status, $allowed_status, true ) ) {
				throw new Exception( 'invalid_post_status' );
			}
			$data['post_status'] = $status;
		}
		if ( empty( $data ) ) {
			throw new Exception( 'empty_post_update' );
		}

		if ( $id > 0 ) {
			$exists = get_post( $id );
			if ( ! $exists || $exists->post_type !== $type ) {
				throw new Exception( 'post_not_found' );
			}
			$data['ID']          = $id;
			$data['post_type']   = $type;
			$result              = wp_update_post( $data, true );
		} else {
			$data['post_type']   = $type;
			$data['post_status'] = isset( $data['post_status'] ) ? $data['post_status'] : 'draft';
			$result              = wp_insert_post( $data, true );
		}
			if ( is_wp_error( $result ) ) {
				throw new Exception( $result->get_error_message() );
			}
			if ( '' !== $operation_id ) {
				update_post_meta( (int) $result, '_pos_operation_id', $operation_id );
			}
		}

		/**
		 * Create a media attachment from a URL the manager supplied (the image
	 * picker references files already on the store or on a public URL).
	 */
		private static function apply_media_create( $remote_id, array $payload ) {
			if ( empty( $payload['url'] ) ) {
				throw new Exception( 'missing_media_url' );
			}
			$operation_id = isset( $payload['__operationId'] ) ? sanitize_text_field( (string) $payload['__operationId'] ) : '';
			if ( '' === $operation_id ) {
				throw new Exception( 'operation_id_missing_for_non_idempotent_media_create' );
			}
			if ( '' !== $operation_id ) {
				$existing = self::post_id_by_operation( $operation_id, 'attachment' );
				if ( $existing > 0 ) {
					return;
				}
			}
		if ( ! function_exists( 'media_sideload_image' ) ) {
			require_once ABSPATH . 'wp-admin/includes/media.php';
			require_once ABSPATH . 'wp-admin/includes/file.php';
			require_once ABSPATH . 'wp-admin/includes/image.php';
		}
		$parent_id = ! empty( $payload['parent'] ) ? (int) $payload['parent'] : 0;
		$desc      = isset( $payload['title'] ) ? (string) $payload['title'] : '';
		$attachment_id = media_sideload_image( esc_url_raw( (string) $payload['url'] ), $parent_id, $desc, 'id' );
			if ( is_wp_error( $attachment_id ) ) {
				throw new Exception( $attachment_id->get_error_message() );
			}
			if ( '' !== $operation_id ) {
				update_post_meta( (int) $attachment_id, '_pos_operation_id', $operation_id );
			}
		}

	/**
	 * The product a job targets, resolving a variation through its parent.
	 *
	 * `wc_get_product()` accepts a variation id and returns the variation, so
	 * the parent is not strictly required — but it is sent, and using it means
	 * a store where a variation id collides with a product id (it happens after
	 * a bad import) still updates the right object.
	 */
	private static function product_for_job( $remote_id, $parent_id = 0 ) {
		$product = wc_get_product( (int) $remote_id );
		if ( $product && $parent_id > 0 && $product->get_parent_id() && (int) $product->get_parent_id() !== $parent_id ) {
			// The id resolved to an object under a different parent than the
			// job named. Trust the parent and re-resolve from it, rather than
			// writing to a variation that happens to share the id.
			$found  = null;
			$parent = wc_get_product( $parent_id );
			// A parent that no longer exists is not a reason to fatal.
			// `wc_get_product()` returns false for a deleted product, and
			// calling ->get_children() on that raised a PHP Error that took the
			// whole cron run down with it — every remaining job unapplied.
			if ( $parent ) {
				foreach ( $parent->get_children() as $child_id ) {
					if ( (int) $child_id === (int) $remote_id ) {
						$found = wc_get_product( $child_id );
						break;
					}
				}
			}
			$product = $found ? $found : $product;
		}
		if ( ! $product ) {
			throw new Exception( 'product_not_found' );
		}
		return $product;
	}

	/**
	 * Send the whole catalogue as ordinary product events.
	 *
	 * This is what «همگام‌سازی محصولات» does in plugin mode: the app cannot read
	 * the store, so it asks, and the answer arrives through the same event path
	 * a single product edit uses. Queued rather than posted directly, so it
	 * inherits the queue's batching and retry instead of trying to push a
	 * thousand products inside one cron run.
	 *
	 * Simple and variable-parent products are queried first, then variations
	 * separately — `wc_get_products` does not return variations unless
	 * explicitly asked with `type=>'variation'`, and a variable product's
	 * children are the sellable units (each with its own stock, price and SKU)
	 * that a missing variation query would silently skip.
	 *
	 * Grouped and external products are included: they are real catalogue rows
	 * with a real type, and leaving them out is what made the app treat an
	 * unrecognised type as "skip".
	 */
	public static function export_products() {
		// Pass 1: every product the store has, of every type and every
		// non-trashed status.
		//
		// No `type` filter on purpose. 1.0.x asked for
		// `array( 'simple', 'variable' )`, which silently dropped grouped,
		// external and every extension's own product type out of the
		// catalogue — and the app then treated those rows as a type it did
		// not recognise. This query returns every `product` post, whatever
		// `product_type` term it carries.
		//
		// No `publish`-only filter either, since 1.3.0. The app's own REST
		// pull reads `/products` with the store's default status filter —
		// `any` — so a plugin-connected store whose owner keeps drafts or
		// private products was exporting a *smaller* catalogue than the same
		// store connected with consumer keys, and "the app is missing
		// products" had its answer right here. Trash and auto-drafts stay
		// out: they are not catalogue rows anywhere.
		$parents    = array();
		$variations = array();
		$page       = 1;
		do {
			$products = wc_get_products(
				array(
					'limit'  => 100,
					'page'   => $page,
					'status' => array( 'publish', 'draft', 'pending', 'private', 'future' ),
					'return' => 'objects',
				)
			);
			foreach ( $products as $product ) {
				// A variation is a `product_variation` post, so it is not in
				// this query — but a plugin that registers its own variation-
				// like type can be, so filter by the type, not by assumption.
				if ( 'variation' === $product->get_type() ) {
					$variations[] = $product;
				} else {
					$parents[] = $product;
				}
			}
			++$page;
		} while ( count( $products ) === 100 );

		// Pass 2: variations — the sellable children under variable products,
		// each with its own SKU, price and stock.
		$page = 1;
		do {
			$children = wc_get_products(
				array(
					'limit'  => 100,
					'page'   => $page,
					'status' => 'publish',
					'type'   => 'variation',
					'return' => 'objects',
				)
			);
			foreach ( $children as $variation ) {
				$variations[] = $variation;
			}
			++$page;
		} while ( count( $children ) === 100 );

		// Parents first, then children: the app cannot create a variation
		// before the row it hangs off exists, and the queue delivers in the
		// order rows were written.
		foreach ( $parents as $product ) {
			POS_Connector_Queue::enqueue( 'product.updated', $product->get_id(), self::product_payload( $product ) );
		}
			foreach ( $variations as $product ) {
				POS_Connector_Queue::enqueue( 'product.updated', $product->get_id(), self::product_payload( $product ) );
			}

			$taxonomy_terms = self::enqueue_taxonomy_snapshot();
			$sync_id        = wp_generate_uuid4();
			POS_Connector_Queue::enqueue(
				'catalogue.sync_completed',
				$sync_id,
				array(
					'id'             => $sync_id,
					'type'           => 'catalogue',
					'products'       => count( $parents ),
					'variations'     => count( $variations ),
					'taxonomy_terms' => $taxonomy_terms,
				)
			);

			POS_Connector_Log::info(
				'export',
				sprintf( '%d محصول و %d تنوع در صف ارسال قرار گرفت.', count( $parents ), count( $variations ) )
			);
			return count( $parents ) + count( $variations );
		}

	/**
	 * Re-send orders changed in the last `$days` days, oldest changed first.
	 *
	 * `wc_get_orders` with `date_modified` is the whole point: it finds the
	 * orders that changed *since the last sweep*, including the ones whose
	 * hooks never fired. Bounded by ORDER_SWEEP_LIMIT *per page* and paged so
	 * a store with a busy week is not silently truncated to the first 200 —
	 * the cap now bounds a single page; the sweep walks pages until the window
	 * is drained or the hard ceiling is reached, and the log says when a
	 * ceiling was hit so the next sweep's shorter window still backfills.
	 */
	public static function export_orders( $days = 7 ) {
		$days = max( 1, min( 365, (int) $days ) );
		$after = gmdate( 'Y-m-d H:i:s', time() - ( $days * DAY_IN_SECONDS ) );

		$enqueued = 0;
		$page     = 1;
		do {
			$orders = wc_get_orders(
				array(
					'limit'         => self::ORDER_SWEEP_LIMIT,
					'offset'        => ( $page - 1 ) * self::ORDER_SWEEP_LIMIT,
					'date_modified' => '>' . $after,
					'orderby'       => 'date',
					'order'         => 'ASC',
					// Refunds and subscriptions are not orders; drafts and trashed
					// rows are not sales.
					'status'        => array_keys( wc_get_order_statuses() ),
					'return'        => 'objects',
				)
			);
			foreach ( $orders as $order ) {
				POS_Connector_Queue::enqueue( 'order.updated', $order->get_id(), self::order_payload( $order ) );
				++$enqueued;
			}
			++$page;
			// Hard ceiling: 100 pages of the page size (20k orders) keeps one
			// cron run finite on a runaway backlog; the next sweep drains more.
		} while ( count( $orders ) === self::ORDER_SWEEP_LIMIT && $page <= 100 );

			$sync_id = wp_generate_uuid4();
			POS_Connector_Queue::enqueue(
				'orders.sync_completed',
				$sync_id,
				array(
					'id'    => $sync_id,
					'type'  => 'orders',
					'count' => $enqueued,
					'days'  => $days,
				)
			);
			POS_Connector_Log::info(
				'export',
				sprintf( '%d سفارشِ %d روز گذشته در صف ارسال قرار گرفت.', $enqueued, $days )
			);
			return $enqueued;
	}

	public static function export_customers() {
		// Two populations, deliberately: the `customer` role is the ordinary
		// book, and `_last_order` is the meta WooCommerce writes on any user
		// who has ever checked out as a registered shopper — including ones an
		// importer or a shop manager created without a role. A site whose
		// «مشتری‌ها» screen counts 600 users was once synced to 20 here
		// because the export only queued what the role query returned on its
		// first pass and nothing ever asked for the rest. The queue's
		// (topic, remote_id) dedup makes the overlap free.
		$customer_ids = array();
		$paged        = 1;
		do {
			$users = get_users(
				array(
					'role__in' => array( 'customer', 'subscriber' ),
					'number'   => 100,
					'paged'    => $paged,
					'fields'   => 'ID',
					'orderby'  => 'ID',
					'order'    => 'ASC',
				)
			);
			foreach ( $users as $user_id ) {
				$customer_ids[ (int) $user_id ] = (int) $user_id;
			}
			++$paged;
			// Hard cap: a site with ten thousand accounts must not enqueue
			// forever inside one cron run; the daily sweep backfills the rest.
		} while ( count( $users ) === 100 && $paged <= 500 );

		// Anyone WooCommerce has ever recorded an order against — catches
		// role-less accounts and legacy customers the role sweep misses.
		$paged = 1;
		do {
			$order_users = get_users(
				array(
					'number'     => 100,
					'paged'      => $paged,
					'fields'     => 'ID',
					'orderby'    => 'ID',
					'order'      => 'ASC',
					'meta_key'   => '_last_order', // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
				)
			);
			foreach ( $order_users as $user_id ) {
				$customer_ids[ (int) $user_id ] = (int) $user_id;
			}
			++$paged;
		} while ( count( $order_users ) === 100 && $paged <= 500 );

		foreach ( $customer_ids as $user_id ) {
			$customer = new WC_Customer( $user_id );
			if ( $customer->get_id() ) {
				POS_Connector_Queue::enqueue( 'customer.updated', $user_id, self::customer_payload( $customer ) );
			}
		}

			$sync_id = wp_generate_uuid4();
			POS_Connector_Queue::enqueue(
				'customers.sync_completed',
				$sync_id,
				array(
					'id'    => $sync_id,
					'type'  => 'customers',
					'count' => count( $customer_ids ),
				)
			);
			POS_Connector_Log::info( 'export', sprintf( '%d مشتری در صف ارسال قرار گرفت.', count( $customer_ids ) ) );
			return count( $customer_ids );
		}

	/**
	 * Queue every post, page and media attachment as a content event — the
	 * «همگام‌سازی محتوا» action, and the answer the app's `content_export`
	 * job. Mirrors export_products: pages of 100, every type the manager
	 * shows, queued rather than posted so the events inherit the batch/retry
	 * path.
	 */
	public static function export_content() {
		$count = 0;
		foreach ( array( 'post', 'page', 'attachment' ) as $type ) {
			$paged = 1;
			do {
				$posts = get_posts(
					array(
						'post_type'      => $type,
						'post_status'    => 'attachment' === $type ? 'inherit' : array( 'publish', 'draft', 'pending', 'private', 'trash' ),
						'posts_per_page' => 100,
						'paged'          => $paged,
						'orderby'        => 'ID',
						'order'          => 'ASC',
						'no_found_rows'  => true,
					)
				);
				foreach ( $posts as $post ) {
					if ( wp_is_post_revision( $post ) || 'auto-draft' === $post->post_status ) {
						continue;
					}
					POS_Connector_Queue::enqueue(
						'content.updated',
						$type . ':' . $post->ID,
						self::content_payload( $post )
					);
					++$count;
				}
				++$paged;
			} while ( count( $posts ) === 100 && $paged <= 500 );
		}
		// This marker is queued after every exported row. The outbound queue is
		// FIFO, so the app only advances its content watermark after the whole
		// snapshot in front of this marker has been accepted.
		$sync_id = wp_generate_uuid4();
		POS_Connector_Queue::enqueue(
			'content.sync_completed',
			$sync_id,
			array(
				'id'    => $sync_id,
				'type'  => 'content',
				'count' => $count,
			)
		);
			POS_Connector_Log::info( 'export', sprintf( '%d محتوای وردپرس در صف ارسال قرار گرفت.', $count ) );
			return $count;
		}

	/** The customer sweep: re-queue the whole customer book. */
	public static function run_resync_customers() {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) || empty( $settings['sync_customers'] ) ) {
			return;
		}
		$movement = self::server_allows_data_movement();
		if ( true !== $movement ) {
			return;
		}
		$settings = pos_connector_settings();
		if ( empty( $settings['sync_customers'] ) ) {
			return;
		}
		self::export_customers();
		pos_connector_update_settings( array( 'last_customers_sweep_at' => current_time( 'mysql', true ) ) );
		self::run();
	}

	/** The content sweep: re-queue posts, pages and media. */
	public static function run_resync_content() {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) ) {
			return;
		}
		$movement = self::server_allows_data_movement();
		if ( true !== $movement ) {
			return;
		}
		self::export_content();
		pos_connector_update_settings( array( 'last_content_sweep_at' => current_time( 'mysql', true ) ) );
		self::run();
	}
}
