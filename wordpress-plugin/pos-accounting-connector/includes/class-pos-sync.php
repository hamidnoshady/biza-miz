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
	 * Issue #939 TAX-15 — most terms one `catalogue.taxonomy_terms` event may
	 * carry. One queue row is one request body, and a term serialises to
	 * roughly 250–350 bytes (a long description pushes it further), so 400
	 * terms stay around 140 KB — an order of magnitude under both the push
	 * batch budget and the app's 2 MB body limit even for pathological
	 * descriptions. A bigger taxonomy is split into numbered chunks sharing a
	 * snapshot id: the app stages chunks and applies nothing until the set is
	 * complete, so a split can never be mistaken for a smaller tree.
	 */
	const TAXONOMY_SNAPSHOT_CHUNK_TERMS = 400;

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

	/**
	 * How long one cron event may spend reading the catalogue before it saves
	 * its place and schedules the rest. A full export of ~1,300 products took
	 * about 216 s in one go (≈165 ms a product), which is over Coolify's 300 s
	 * task timeout as soon as another event is due, and blocked the fast lane
	 * for its whole length. 18 s keeps one tick under the ~25 s a request or a
	 * cron event is expected to stay inside.
	 */
	const EXPORT_TIME_BUDGET_SECONDS = 18;

	/** Products read per query — small, so the time budget is checked often. */
	const PRODUCT_EXPORT_BATCH = 20;

	/** An export nobody finished within this many seconds is abandoned and restarted. */
	const PRODUCT_EXPORT_MAX_AGE_SECONDS = DAY_IN_SECONDS;

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
		// A large customer export continues in bounded WP-Cron batches, with its
		// run id and cursor kept separately so concurrent runs cannot overwrite.
		add_action( 'pos_connector_customer_export_continue', array( __CLASS__, 'continue_customer_export' ), 10, 1 );
		// The same for the catalogue (1.6.19): one resync used to be a single
		// ~200 s request on a 1,300-product store.
		add_action( POS_CONNECTOR_CRON_PRODUCT_EXPORT, array( __CLASS__, 'continue_product_export' ), 10, 1 );
		// A button press, run by cron instead of inside the admin request.
		add_action( POS_CONNECTOR_CRON_MANUAL_JOB, array( __CLASS__, 'run_manual_job' ), 10, 1 );

		$settings = pos_connector_settings();
		if ( ! empty( $settings['enabled'] ) && ! empty( $settings['sync_customers'] ) ) {
			// Recover exports that were paused, missed by WP-Cron, or interrupted
			// while this plugin was disabled; the persisted keyset is authoritative.
			self::schedule_pending_customer_exports();
		}
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
			// Issue #939 TAX-11 — term-level hooks. Before these, a category
			// renamed at 09:00 reached the app at the next full catalogue
			// sweep, and a category deleted at 09:01 kept ghosting the
			// taxonomy mirror until then. WordPress fires these for every
			// taxonomy (including product_cat, product_tag, pa_* and any
			// custom one); the handler keeps only the product taxonomies and
			// enqueues a fresh snapshot of that ONE taxonomy, which the queue
			// coalesces by (topic, taxonomy) — ten term edits in a minute are
			// one pending row carrying the latest tree. The full sweeps still
			// run, as the reconciliation backstop for a missed hook.
			add_action( 'created_term', array( __CLASS__, 'on_term_created' ), 20, 3 );
			add_action( 'edited_term', array( __CLASS__, 'on_term_edited' ), 20, 3 );
			// `deleted_term` fires AFTER the delete, so the snapshot it
			// builds no longer contains the removed term — `delete_term`
			// (before) would have re-sent it as alive.
			add_action( 'deleted_term', array( __CLASS__, 'on_term_deleted' ), 20, 4 );
		}

		if ( ! empty( $settings['sync_customers'] ) ) {
			add_action( 'woocommerce_created_customer', array( __CLASS__, 'on_customer_changed' ), 20, 1 );
			add_action( 'woocommerce_update_customer', array( __CLASS__, 'on_customer_changed' ), 20, 1 );
			// Core profile and importer/meta hooks cover customer changes that do
			// not pass through Woo's CRUD screen. The handler filters out unrelated
			// users and sensitive metadata before queueing a store snapshot.
			add_action( 'profile_update', array( __CLASS__, 'on_customer_changed' ), 20, 1 );
			add_action( 'user_register', array( __CLASS__, 'on_customer_changed' ), 20, 1 );
			add_action( 'added_user_meta', array( __CLASS__, 'on_customer_meta_changed' ), 20, 4 );
			add_action( 'updated_user_meta', array( __CLASS__, 'on_customer_meta_changed' ), 20, 4 );
			add_action( 'deleted_user_meta', array( __CLASS__, 'on_customer_meta_changed' ), 20, 4 );
			add_action( 'delete_user', array( __CLASS__, 'on_customer_deleted' ), 20, 1 );
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

	public static function on_customer_changed( $customer_id, $deduplicate = true ) {
		$customer_id = absint( $customer_id );
		if (
			! $customer_id || ! self::is_customer_user( $customer_id ) ||
			( $deduplicate && self::already_seen( 'customer', $customer_id ) )
		) {
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

	/**
	 * WordPress importer/profile-meta paths often bypass Woo's customer CRUD
	 * hooks. Only customer fields that contribute to the synchronized snapshot
	 * cause a refresh; consent and unrelated account metadata are never copied.
	 */
	public static function on_customer_meta_changed( $meta_id, $user_id, $meta_key, $meta_value = null ) {
		$customer_meta_keys = array(
			'first_name',
			'last_name',
			'billing_first_name',
			'billing_last_name',
			'billing_address_1',
			'billing_city',
			'billing_email',
			'billing_phone',
			'_last_order',
			'_order_count',
		);
		if ( in_array( (string) $meta_key, $customer_meta_keys, true ) ) {
			// The first account hook may have queued a partial profile before
			// WooCommerce writes billing metadata. Requeue without the request-local
			// guard; the durable queue coalesces pending snapshots by identity and
			// retains the final values rather than freezing the first payload.
			self::on_customer_changed( $user_id, false );
		}
	}

	/** A genuine WooCommerce account or recorded shopper, not an arbitrary WP user. */
	private static function is_customer_user( $user_id ) {
		$user_id = absint( $user_id );
		$user    = $user_id ? get_userdata( $user_id ) : false;
		if ( ! $user ) {
			return false;
		}
		if ( array_intersect( array( 'customer', 'subscriber' ), (array) $user->roles ) ) {
			return true;
		}
		return metadata_exists( 'user', $user_id, '_last_order' ) || (int) get_user_meta( $user_id, '_order_count', true ) > 0;
	}

	/** Preserve remote identity tombstones without removing local CRM history. */
	public static function on_customer_deleted( $customer_id ) {
		$customer_id = absint( $customer_id );
		if ( ! $customer_id || ! self::is_customer_user( $customer_id ) ) {
			return;
		}
		POS_Connector_Queue::enqueue(
			'customer.deleted',
			$customer_id,
			array(
				'id'         => $customer_id,
				'deleted_at' => gmdate( 'c' ),
			)
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
		if ( ! $post || 'attachment' === $post->post_type || ! in_array( $post->post_type, self::mirrored_post_types(), true ) ) {
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
				'revision' => self::next_content_revision(),
				'operation_id' => (string) get_post_meta( $attachment_id, '_pos_operation_id', true ),
			)
		);
	}

	/**
	 * One post/page/attachment in the app's content-payload shape — the
	 * WordPress core REST fields the manager app reads.
	 */
	private static function media_payload_lock( $id ) {
		global $wpdb;
		// Old MySQL GET_LOCK silently releases another lock on this connection,
		// which would defeat the enclosing create-operation idempotency lock.
		$server = $wpdb->db_server_info();
		if ( false !== stripos( $server, 'MariaDB' ) ) {
			if ( ! preg_match( '/([0-9]+\.[0-9]+\.[0-9]+)-MariaDB/i', $server, $match ) || version_compare( $match[1], '10.0.2', '<' ) ) throw new Exception( 'media_requires_modern_mysql' );
		} elseif ( version_compare( $wpdb->db_version(), '5.7.5', '<' ) ) throw new Exception( 'media_requires_modern_mysql' );
		return 'pos_payload_' . substr( hash( 'sha256', $wpdb->prefix . ':' . (int) $id ), 0, 48 );
	}

	public static function content_payload( $post ) {
		if ( 'attachment' !== $post->post_type ) return self::build_content_payload( $post );
		global $wpdb;
		$lock = self::media_payload_lock( $post->ID );
		if ( '1' !== (string) $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, 5)', $lock ) ) ) throw new Exception( 'media_payload_busy' );
		try {
			// Serialize all producers *before* reading, not just the clock
			// increment. A previously cached post must not get a newer revision.
			clean_post_cache( $post->ID );
			$fresh = get_post( $post->ID );
			if ( ! $fresh ) throw new Exception( 'attachment_not_found' );
			return self::build_content_payload( $fresh );
		} finally { $wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock ) ); }
	}

	private static function build_content_payload( $post ) {
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
			$payload['revision'] = self::next_content_revision();
			update_post_meta( $post->ID, '_pos_content_revision', $payload['revision'] );
			$payload['excerpt'] = array( 'raw' => $post->post_excerpt );
			$payload['content'] = array( 'raw' => $post->post_content );
			$file = get_attached_file( $post->ID );
			$payload['filename'] = $file ? wp_basename( $file ) : '';
			$payload['filesize'] = $file && is_file( $file ) ? filesize( $file ) : null;
			$payload['source_url'] = wp_get_attachment_url( $post->ID ) ?: '';
			$payload['mime_type']  = $post->post_mime_type;
			$metadata = wp_get_attachment_metadata( $post->ID );
			$thumb = wp_get_attachment_image_src( $post->ID, 'thumbnail' );
			$payload['media_details'] = array( 'width' => isset( $metadata['width'] ) ? (int) $metadata['width'] : null, 'height' => isset( $metadata['height'] ) ? (int) $metadata['height'] : null, 'sizes' => array( 'thumbnail' => array( 'source_url' => $thumb ? $thumb[0] : '' ) ) );
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
			// Same echo as the attachment branch: only a post this store created
			// from a `post_upsert` job carries the meta, so the app can tell "the
			// create I queued landed as post #123" from a post written by hand.
			$operation_id = get_post_meta( $post->ID, '_pos_operation_id', true );
			if ( $operation_id ) {
				$payload['operation_id'] = (string) $operation_id;
			}
		}
		return $payload;
	}

	/** A DB-serialized, durable clock. Never use second-resolution WP dates for
	 * ordering two edits/trash events within the same second.
	 */
	private static function next_content_revision() {
		global $wpdb;
		$wpdb->query( "INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES ('pos_content_revision', '0', 'no')" );
		if ( false === $wpdb->query( "UPDATE {$wpdb->options} SET option_value = LAST_INSERT_ID(CAST(option_value AS UNSIGNED) + 1) WHERE option_name = 'pos_content_revision'" ) ) {
			throw new Exception( 'content_revision_failed' );
		}
		return (string) $wpdb->get_var( 'SELECT LAST_INSERT_ID()' );
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
				'quantity'     => $item->get_quantity(),
				'price'        => (string) $order->get_item_subtotal( $item, false, false ),
				'total'        => (string) $item->get_total(),
				'subtotal'     => (string) $item->get_subtotal(),
				'total_tax'    => (string) $item->get_total_tax(),
				'sku'          => $product ? $product->get_sku() : '',
				'meta_data'    => self::public_order_item_meta( $item ),
				// The parent's name, so the app can label a variation line the
				// way the customer saw it.
				'parent_name'  => $product && $product->get_parent_id() ? get_the_title( $product->get_parent_id() ) : '',
			);
		}

		$shipping_lines = array();
		foreach ( $order->get_items( 'shipping' ) as $line ) {
			$shipping_lines[] = array( 'method_id' => $line->get_method_id(), 'method_title' => $line->get_method_title(), 'total' => (string) $line->get_total(), 'total_tax' => (string) $line->get_total_tax() );
		}
		$fee_lines = array();
		foreach ( $order->get_items( 'fee' ) as $line ) {
			$fee_lines[] = array( 'name' => $line->get_name(), 'total' => (string) $line->get_total(), 'total_tax' => (string) $line->get_total_tax() );
		}
		$coupon_lines = array();
		foreach ( $order->get_items( 'coupon' ) as $line ) {
			$coupon_lines[] = array( 'code' => $line->get_code(), 'discount' => (string) $line->get_discount(), 'discount_tax' => (string) $line->get_discount_tax() );
		}
		$refunds = array();
		foreach ( $order->get_refunds() as $refund ) {
			$refunds[] = array( 'id' => $refund->get_id(), 'total' => (string) $refund->get_total() );
		}
		// Shipment Tracking extension metadata only. Do not export arbitrary
		// private order meta, gateway credentials, internal notes or guessed IDs.
		$shipments = array();
		$tracking = $order->get_meta( '_wc_shipment_tracking_items', true );
		foreach ( is_array( $tracking ) ? $tracking : array() as $shipment ) {
			if ( ! is_array( $shipment ) || empty( $shipment['tracking_number'] ) ) { continue; }
			$shipments[] = array(
				'tracking_number' => sanitize_text_field( $shipment['tracking_number'] ),
				'tracking_provider' => sanitize_text_field( isset( $shipment['tracking_provider'] ) ? $shipment['tracking_provider'] : '' ),
				'custom_tracking_provider' => sanitize_text_field( isset( $shipment['custom_tracking_provider'] ) ? $shipment['custom_tracking_provider'] : '' ),
			);
		}

		return array(
			'id'             => $order->get_id(),
			'number'         => $order->get_order_number(),
			'status'         => $order->get_status(),
			'currency'       => $order->get_currency(),
			'currency_decimals' => wc_get_price_decimals(),
			'total'          => (string) $order->get_total(),
			'total_tax'      => (string) $order->get_total_tax(),
			'shipping_total' => (string) $order->get_shipping_total(),
			'shipping_tax'   => (string) $order->get_shipping_tax(),
			'discount_tax'   => (string) $order->get_discount_tax(),
			'total_refunded' => (string) $order->get_total_refunded(),
			'discount_total' => (string) $order->get_discount_total(),
			'payment_method' => $order->get_payment_method(),
			'payment_method_title' => $order->get_payment_method_title(),
			'customer_note'  => $order->get_customer_note(),
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
				'address_2'  => $order->get_billing_address_2(),
				'state'      => $order->get_billing_state(),
				'postcode'   => $order->get_billing_postcode(),
				'country'    => $order->get_billing_country(),
			),
			'shipping'       => array(
				'first_name' => $order->get_shipping_first_name(), 'last_name' => $order->get_shipping_last_name(),
				'company' => $order->get_shipping_company(),
				'phone' => is_callable( array( $order, 'get_shipping_phone' ) ) ? $order->get_shipping_phone() : '',
				'address_1' => $order->get_shipping_address_1(), 'address_2' => $order->get_shipping_address_2(),
				'city' => $order->get_shipping_city(), 'state' => $order->get_shipping_state(),
				'postcode' => $order->get_shipping_postcode(), 'country' => $order->get_shipping_country(),
			),
			'shipping_lines' => $shipping_lines, 'fee_lines' => $fee_lines, 'coupon_lines' => $coupon_lines,
			'refunds' => $refunds, 'shipments' => $shipments,
			'line_items'     => $items,
		);
	}

	/** Only public variation/display fields, not private line metadata. */
	private static function public_order_item_meta( $item ) {
		$out = array();
		foreach ( $item->get_meta_data() as $meta ) {
			$data = $meta->get_data();
			$key = isset( $data['key'] ) ? (string) $data['key'] : '';
			if ( '' === $key || '_' === substr( $key, 0, 1 ) || ! is_scalar( $data['value'] ) ) { continue; }
			$out[] = array( 'key' => $key, 'value' => sanitize_text_field( (string) $data['value'] ) );
		}
		return $out;
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

		/**
		 * Queue a full snapshot of every product taxonomy. The reconciliation
		 * backstop: targeted term-change events (TAX-11) keep the mirror fresh
		 * between sweeps, and this keeps them honest.
		 */
		private static function enqueue_taxonomy_snapshot() {
			$total = 0;
			foreach ( array_keys( self::product_taxonomies() ) as $taxonomy ) {
				$total += self::enqueue_taxonomy_snapshot_for( $taxonomy );
			}
			return $total;
		}

		/**
		 * Queue a full snapshot of ONE product taxonomy.
		 *
		 * Issue #939 TAX-15: the payload carries `generated_at` — the store-side
		 * moment this tree reflects. The app refuses a snapshot older than the
		 * one its mirror already holds, which is what stops a retried or
		 * reordered queue row from resurrecting terms a newer snapshot deleted.
		 * Snapshots too large for one request body are split into numbered
		 * chunks sharing one `snapshot_id`; the app stages chunks and applies
		 * the replace only when the set is complete.
		 *
		 * @return int How many terms were queued.
		 */
		private static function enqueue_taxonomy_snapshot_for( $taxonomy ) {
			try {
				$terms = get_terms(
					array(
						'taxonomy'   => $taxonomy,
						'hide_empty' => false,
					)
				);
				if ( is_wp_error( $terms ) ) {
					POS_Connector_Log::error(
						'taxonomy',
						sprintf( '%s — %s', (string) $taxonomy, $terms->get_error_message() )
					);
					return 0;
				}
				$payload_terms = array_map( array( __CLASS__, 'term_payload' ), (array) $terms );
				$total         = count( $payload_terms );
				$generated_at  = current_time( 'c', true );

				if ( $total <= self::TAXONOMY_SNAPSHOT_CHUNK_TERMS ) {
					POS_Connector_Queue::enqueue(
						'catalogue.taxonomy_terms',
						$taxonomy,
						array(
							'id'           => $taxonomy,
							'taxonomy'     => $taxonomy,
							'terms'        => $payload_terms,
							'generated_at' => $generated_at,
						)
					);
					return $total;
				}

				$snapshot_id = wp_generate_uuid4();
				$chunks      = array_chunk( $payload_terms, self::TAXONOMY_SNAPSHOT_CHUNK_TERMS );
				$chunk_count = count( $chunks );
				foreach ( $chunks as $chunk_index => $chunk_terms ) {
					// Keyed per chunk so the queue's (topic, remote_id)
					// coalescing cannot merge two chunks of one snapshot into
					// each other, while a re-run of the same snapshot still
					// refreshes its own pending chunks in place.
					POS_Connector_Queue::enqueue(
						'catalogue.taxonomy_terms',
						$taxonomy . '#' . $snapshot_id . '#' . $chunk_index,
						array(
							'id'           => $taxonomy,
							'taxonomy'     => $taxonomy,
							'terms'        => $chunk_terms,
							'generated_at' => $generated_at,
							'snapshot_id'  => $snapshot_id,
							'chunk_index'  => $chunk_index,
							'chunk_count'  => $chunk_count,
						)
					);
				}
				return $total;
			} catch ( \Throwable $e ) {
				POS_Connector_Log::error(
					'taxonomy',
					sprintf( '%s — %s', (string) $taxonomy, $e->getMessage() )
				);
				return 0;
			}
		}

		// -------------------------------------------------------------------
		// Term-level hooks (issue #939 TAX-11)
		//
		// `created_term`  fires as ( $term_id, $tt_id, $taxonomy ).
		// `edited_term`   fires as ( $term_id, $taxonomy, $tt_id ) — note the
		//                 swapped second argument, a WordPress inconsistency
		//                 these wrappers exist to absorb.
		// `deleted_term`  fires as ( $term, $tt_id, $taxonomy, $deleted_term ).
		// -------------------------------------------------------------------

		public static function on_term_created( $term_id, $tt_id, $taxonomy ) {
			self::maybe_enqueue_taxonomy_snapshot( $taxonomy );
		}

		public static function on_term_edited( $term_id, $taxonomy, $tt_id ) {
			self::maybe_enqueue_taxonomy_snapshot( $taxonomy );
		}

		public static function on_term_deleted( $term, $tt_id, $taxonomy, $deleted_term ) {
			self::maybe_enqueue_taxonomy_snapshot( $taxonomy );
		}

		/**
		 * Queue a targeted refresh for one product taxonomy after a term
		 * changed. Blog categories and post tags are ignored; a taxonomy this
		 * store does not attach to products never reaches the mirror anyway.
		 */
		private static function maybe_enqueue_taxonomy_snapshot( $taxonomy ) {
			if ( ! is_string( $taxonomy ) || '' === $taxonomy ) {
				return;
			}
			$product_taxonomies = self::product_taxonomies();
			if ( ! isset( $product_taxonomies[ $taxonomy ] ) ) {
				return;
			}
			// A bulk term operation fires the hook per term; one snapshot per
			// taxonomy per request is enough — the queue row it refreshes is
			// coalesced anyway, and rebuilding the whole tree per hook call
			// would spend the request on duplicate get_terms queries.
			if ( self::already_seen( 'taxonomy', $taxonomy ) ) {
				return;
			}
			self::enqueue_taxonomy_snapshot_for( $taxonomy );
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
		$date_modified = $customer->get_date_modified();
		$user           = get_userdata( $customer->get_id() );
		$roles          = $user ? (array) $user->roles : array();
		$role           = in_array( 'customer', $roles, true ) ? 'customer' : ( in_array( 'subscriber', $roles, true ) ? 'subscriber' : ( ! empty( $roles ) ? (string) reset( $roles ) : '' ) );
		$order_count    = max( 0, (int) get_user_meta( $customer->get_id(), '_order_count', true ) );
		$is_paying      = method_exists( $customer, 'get_is_paying_customer' )
			? (bool) $customer->get_is_paying_customer()
			: $order_count > 0;

		return array(
			'id'                 => $customer->get_id(),
			'date_modified'      => $date_modified ? $date_modified->date( 'c' ) : null,
			'email'              => $customer->get_email(),
			'first_name'         => $customer->get_first_name(),
			'last_name'          => $customer->get_last_name(),
			'role'               => $role,
			'orders_count'        => $order_count,
			'is_paying_customer' => $is_paying,
			'billing'            => array(
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
				'last_sync_ok_at' => current_time( 'mysql', true ),
				'last_error'      => __( 'همگام‌سازی از سمت پنل متوقف شده است', 'pos-accounting-connector' ),
				'last_run_stats'  => array( 'paused' => true, 'at' => current_time( 'mysql', true ) ),
			)
		);
		POS_Connector_Log::info( 'paused', 'همگام‌سازی از سمت پنل متوقف شده است' );
	}

	/**
	 * Handshake with the app and decide whether data may move.
	 *
	 * Returns `array( 'state' => true|'paused'|false, 'client' => ?, 'handshake' => ? )`.
	 * The client and handshake ride along on `true` so the caller can hand them
	 * to `run()` instead of paying for a second handshake in the same event.
	 */
	private static function gate() {
		$client = POS_Connector_Client::from_settings();
		if ( ! $client ) {
			POS_Connector_Log::error( 'handshake', 'not_configured' );
			return array( 'state' => false );
		}
		$handshake = self::handshake( $client );
		if ( ! $handshake['ok'] ) {
			pos_connector_update_settings( array( 'last_error' => POS_Connector_Client::explain( $handshake['error'] ) ) );
			POS_Connector_Log::error( 'handshake', $handshake['error'] );
			return array( 'state' => false );
		}
		if ( isset( $handshake['data']['serverStatus'] ) && 'paused' === $handshake['data']['serverStatus'] ) {
			self::record_server_paused();
			return array( 'state' => 'paused' );
		}
		return array( 'state' => true, 'client' => $client, 'handshake' => $handshake );
	}

	/**
	 * Freshly ask the app whether data movement is allowed. Used by the scheduled
	 * backfills and manual export jobs before they read a large local data set
	 * into the plugin queue; handshake/ping/health still works while paused.
	 */
	public static function server_allows_data_movement() {
		$gate = self::gate();
		return $gate['state'];
	}

	/**
	 * The fast lane. `$gate` is the answer of a handshake this same event has
	 * already made (see `gate()`); without it the run makes its own.
	 *
	 * Serialised with a short lock: `wp pos-connector sync` and `wp cron event
	 * run --due-now` are both documented ways to drive the plugin, and two runs
	 * at once would lease and apply the same jobs twice.
	 */
	public static function run( $gate = null ) {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) ) {
			return;
		}

		if ( ! POS_Connector_Client::from_settings() ) {
			POS_Connector_Log::error( 'run', 'not_configured' );
			return;
		}

		$store = new POS_Connector_Option_Lock_Store();
		$token = POS_Connector_Lock::acquire( 'run', POS_Connector_Health::RUN_LOCK_TTL_SECONDS, time(), $store );
		if ( false === $token ) {
			POS_Connector_Log::info( 'run', 'run_locked' );
			return array( 'locked' => true, 'pushed' => 0, 'applied' => 0 );
		}
		try {
			return self::run_locked( $settings, is_array( $gate ) ? $gate : null );
		} finally {
			POS_Connector_Lock::release( 'run', $token, $store );
			self::$previous_run = null;
		}
	}

	/** What `telemetry()` should say about the run in progress: when the previous one started, and whether the cron had stopped. */
	private static $previous_run = null;

	private static function run_locked( array $settings, $gate ) {
		// Recorded before anything can fail: «کرون اجرا می‌شود» and «همگام‌سازی
		// موفق بود» are different facts, and the first is the one the stale
		// check watches.
		$status = POS_Connector_Health::cron_status( $settings, time() );
		self::$previous_run = array(
			'at'    => $settings['last_run_at'],
			'stale' => $status['stale'],
			'age'   => $status['age'],
		);
		pos_connector_update_settings( array( 'last_run_at' => current_time( 'mysql', true ) ) );
		// A pending catalogue/customer export whose continuation was lost
		// (cron option rebuilt, event fired while paused) is put back.
		self::schedule_pending_product_exports();

		if ( null === $gate || true !== $gate['state'] ) {
			$gate = self::gate();
			if ( true !== $gate['state'] ) {
				return 'paused' === $gate['state'] ? array( 'paused' => true, 'pushed' => 0, 'applied' => 0 ) : null;
			}
		}
		$client = $gate['client'];

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
				'last_sync_ok_at' => current_time( 'mysql', true ),
				'last_error'      => '',
				'last_run_stats'  => $stats,
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
	 * The catalogue sweep: start (or join) the catalogue export. It reads a
	 * bounded slice now and continues from its saved place in later cron
	 * events; the fast lane ships what it queues.
	 */
	public static function run_resync_products() {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) || empty( $settings['sync_products'] ) ) {
			return;
		}
		$gate = self::gate();
		if ( true !== $gate['state'] ) {
			return;
		}
		$settings = pos_connector_settings();
		if ( empty( $settings['sync_products'] ) ) {
			return;
		}
		self::export_products();
		pos_connector_update_settings( array( 'last_products_sweep_at' => current_time( 'mysql', true ) ) );
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
		$gate = self::gate();
		if ( true !== $gate['state'] ) {
			return;
		}
		$settings = pos_connector_settings();
		if ( empty( $settings['sync_orders'] ) ) {
			return;
		}
		self::export_orders( (int) $settings['resync_orders_days'] );
		pos_connector_update_settings( array( 'last_orders_sweep_at' => current_time( 'mysql', true ) ) );
		self::run( $gate );
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
			'mediaTrash' => defined( 'MEDIA_TRASH' ) && MEDIA_TRASH && defined( 'EMPTY_TRASH_DAYS' ) && EMPTY_TRASH_DAYS > 0,
			'eventTypes' => array(
				'order.created',
				'order.updated',
				'refund.created',
				'product.updated',
				'customer.updated',
				'customer.deleted',
				'content.updated',
				'content.deleted',
				'catalogue.taxonomy_terms',
				'catalogue.sync_completed',
				'orders.sync_completed',
				'customers.sync_completed',
				'content.sync_completed',
				'content.media_snapshot_completed',
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
				'media_update',
				// Issue #939: re-send only the taxonomy tree.
				'taxonomy_export',
			),
		);
	}

		private static function telemetry() {
			$settings = pos_connector_settings();
			$counts   = POS_Connector_Queue::counts();
			if ( is_array( self::$previous_run ) ) {
				$cron = self::$previous_run;
			} else {
				$status = POS_Connector_Health::cron_status( $settings, time() );
				$cron   = array( 'at' => $settings['last_run_at'], 'stale' => $status['stale'], 'age' => $status['age'] );
			}
			return array(
				'pluginVersion'       => POS_CONNECTOR_VERSION,
				'siteUrl'             => home_url(),
				'wordpressVersion'    => get_bloginfo( 'version' ),
				'woocommerceVersion'  => defined( 'WC_VERSION' ) ? WC_VERSION : null,
				'phpVersion'          => PHP_VERSION,
				// `lastSuccessfulRun` keeps its 1.x name; it is now the last FULL
				// sync (handshake, push, pull), never a button press — the old
				// value moved on «آزمایش اتصال» and hid two days of dead cron.
				'lastSuccessfulRun'   => $settings['last_sync_ok_at'],
				// When the fast lane last started (before this run, when this is
				// one), and whether it had stopped: a run that follows a long
				// silence reports the silence it ended.
				'lastRunAt'           => $cron['at'],
				'cronStale'           => $cron['stale'],
				'cronGapSeconds'      => $cron['age'],
				'systemCron'          => pos_connector_uses_system_cron(),
				'productExportsInProgress' => count( self::pending_product_exports() ),
				'lastLocalError'      => $settings['last_error'],
				'localQueuePending'   => (int) $counts['pending'],
				'localQueueDeferred'  => (int) POS_Connector_Queue::deferred_count(),
				'localQueueFailed'    => (int) $counts['failed'],
				// Per-event problem list (issue #942, F12): which events are stuck and why.
				'localQueueRecent'    => POS_Connector_Queue::recent_problems( 10 ),
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
					// Protocol 3: lease-token acks + the `skipped` ack (issue #942).
				// The app only issues lease tokens to plugins advertising ≥ 3,
				// so an older app keeps its legacy ack path untouched.
				'protocolVersion' => 3,
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
			// The lease generation this job was handed out under (issue #942,
			// F01). Echoed in every ack for the job: if this run's lease
			// expired and the app re-leased the job — possibly with a newer
			// payload — the app ignores this run's ack instead of letting it
			// close the newer attempt. Absent against an older app, which
			// then falls back to its status guard.
			$ack = array( 'id' => $job_id );
			if ( ! empty( $job['leaseToken'] ) ) {
				$ack['leaseToken'] = (string) $job['leaseToken'];
			}
			// `Throwable`, not `Exception`: apply_job calls into WooCommerce and
			// WordPress, where a deleted product or a plugin conflict raises a
			// PHP `Error` — which `catch ( Exception )` does not catch. One such
			// job aborted the whole run *before the ack below*, so every job
			// already applied above it was never reported done, its lease
			// expired, and it was applied a second time on the next run. For
			// `refund_create` that is a second refund against the same order.
			try {
				$outcome = self::apply_job( $job );
				if ( is_string( $outcome ) && 0 === strpos( $outcome, 'skipped:' ) ) {
					// Deliberately not applied — this site's policy switch for
					// the field is off (issue #942, F10). Acking `done` would
					// tell the app the store now holds a value it never
					// received; `skipped` keeps the app's last-pushed record
					// honest.
					$ack['status'] = 'skipped';
					$ack['error']  = substr( $outcome, strlen( 'skipped:' ) );
					$results[]     = $ack;
					continue;
				}
				$ack['status'] = 'done';
				$results[]     = $ack;
				++$applied;
			} catch ( Throwable $e ) {
				$ack['status'] = 'failed';
				$ack['error']  = $e->getMessage();
				$results[]     = $ack;
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
	 * reported as done. The one non-throwing signal is a `'skipped:<reason>'`
	 * return: the job was deliberately not applied because this site's policy
	 * switch for the field is off, and the caller acks it `skipped` so the
	 * app never records an unwritten value as delivered (issue #942, F10).
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
					// The owner switched this off on the accounting side.
					// Nothing went wrong and nothing was written, so this is
					// neither `done` (the store does not hold the value) nor
					// `failed` (retrying six times changes nothing): the
					// caller acks it `skipped` (issue #942, F10).
					return 'skipped:apply_stock_disabled';
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
					// Same policy skip as `stock` above — acked `skipped`,
					// never `done` (issue #942, F10).
					return 'skipped:apply_prices_disabled';
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
				// Deferred: this job is applied inside the fast lane's own time
				// budget, and reading the catalogue is what has no bound of its own.
				self::export_products( null, true );
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

			case 'taxonomy_export':
				// Issue #939 TAX-12 — «همگام‌سازی از وب‌سایت» on the taxonomy
				// screen, in plugin mode: re-queue the tree only, without the
				// full catalogue sweep `catalogue_export` would run.
				self::enqueue_taxonomy_snapshot();
				return;

			case 'post_upsert':
				self::apply_post_upsert( $payload );
				return;

			case 'media_update':
				self::apply_media_update( $payload );
				break;

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
					'post_status'    => 'attachment' === $type ? array( 'inherit', 'publish', 'draft', 'pending', 'private', 'future', 'trash' ) : array( 'publish', 'draft', 'pending', 'private', 'future', 'trash' ),
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
			$data['post_title'] = sanitize_text_field( (string) $payload['title'] );
		}
		if ( isset( $payload['content'] ) ) {
			// Content is the owner's own HTML from their own accounting app;
			// wp_kses_post keeps the same tag set the post editor allows.
			$data['post_content'] = wp_kses_post( (string) $payload['content'] );
		}
		if ( isset( $payload['excerpt'] ) ) {
			// Keep intentional excerpt line breaks while using WordPress's safe text-field sanitizer.
			$data['post_excerpt'] = sanitize_textarea_field( (string) $payload['excerpt'] );
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
	/** Serialize a non-idempotent import and commit attachment, meta and event
	 * together. A killed PHP process rolls back the entire InnoDB transaction;
	 * its connection-scoped advisory lock is automatically released as well.
	 */
	private static function apply_media_create( $remote_id, array $payload ) {
		global $wpdb;
		$operation_id = isset( $payload['__operationId'] ) ? sanitize_text_field( (string) $payload['__operationId'] ) : '';
		if ( '' === $operation_id ) {
			throw new Exception( 'operation_id_missing_for_non_idempotent_media_create' );
		}
		if ( ! POS_Connector_Queue::maybe_install() ) {
			throw new Exception( 'media_queue_unavailable' );
		}
		// Fail closed on legacy MyISAM installs: pretending transactions work
		// would recreate the exact import/meta crash window this guard closes.
		foreach ( array( $wpdb->posts, $wpdb->postmeta, $wpdb->options, POS_Connector_Queue::table_name() ) as $table ) {
			$engine = $wpdb->get_var( $wpdb->prepare( 'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $table ) );
			if ( 'innodb' !== strtolower( (string) $engine ) ) {
				throw new Exception( 'media_requires_innodb' );
			}
		}
		self::media_payload_lock( 0 ); // Verify multiple/nested named-lock support.
		$lock = 'pos_media_' . substr( hash( 'sha256', $wpdb->prefix . $operation_id ), 0, 48 );
		if ( '1' !== (string) $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, 0)', $lock ) ) ) {
			throw new Exception( 'media_operation_busy' );
		}
		$attachment_id = 0;
		try {
			if ( false === $wpdb->query( 'START TRANSACTION' ) ) {
				throw new Exception( 'media_transaction_failed' );
			}
			$existing = self::post_id_by_operation( $operation_id, 'attachment' );
			if ( $existing > 0 ) {
				self::enqueue_media_confirmation( $existing );
			} else {
				if ( empty( $payload['url'] ) ) {
					throw new Exception( 'missing_media_url' );
				}
				require_once ABSPATH . 'wp-admin/includes/media.php';
				require_once ABSPATH . 'wp-admin/includes/file.php';
				require_once ABSPATH . 'wp-admin/includes/image.php';
				require_once __DIR__ . '/class-pos-media-import.php';
				// Trusted WP plugins may replace the importer (also permits a
				// deterministic local fixture in the core hook/transaction tests).
				$import = apply_filters( 'pos_media_import_callback', array( 'POS_Connector_Media_Import', 'create' ) );
				$attachment_id = call_user_func( $import, (string) $payload['url'], isset( $payload['title'] ) ? sanitize_text_field( $payload['title'] ) : '' );
				if ( is_wp_error( $attachment_id ) ) {
					$attachment_id = 0;
					throw new Exception( 'media_import_failed' );
				}
				do_action( 'pos_media_after_import', $attachment_id, $operation_id );
				if ( ! update_post_meta( $attachment_id, '_pos_operation_id', $operation_id ) ) {
					throw new Exception( 'media_operation_stamp_failed' );
				}
				// A fault-injection seam used by the real WP transaction test.
				do_action( 'pos_media_before_commit', $attachment_id, $operation_id );
				self::enqueue_media_confirmation( $attachment_id );
			}
			if ( false === $wpdb->query( 'COMMIT' ) ) {
				throw new Exception( 'media_commit_failed' );
			}
		} catch ( \Throwable $error ) {
			if ( $attachment_id > 0 ) {
				wp_delete_attachment( $attachment_id, true );
			}
			$wpdb->query( 'ROLLBACK' );
			throw $error;
		} finally {
			$wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock ) );
		}
	}

	private static function media_usage( $id ) {
		global $wpdb;
		$featured = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key = '_thumbnail_id' AND meta_value = %s", (string) $id ) );
		$gallery = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key = '_product_image_gallery' AND FIND_IN_SET(%s, meta_value)", (string) $id ) );
		$url = wp_get_attachment_url( $id );
		$embedded = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type IN ('post','page','product') AND post_status <> 'trash' AND (post_content REGEXP %s OR post_content LIKE %s)", 'wp-image-' . (int) $id . '([^0-9]|$)', '%' . $wpdb->esc_like( $url ?: 'pos_no_url_match' ) . '%' ) );
		return array( 'featured' => $featured, 'galleries' => $gallery, 'embedded' => $embedded, 'total' => $featured + $gallery + $embedded, 'checked_at' => gmdate( 'c' ), 'note' => 'External links and custom plugin references cannot be exhaustively detected.' );
	}

	private static function apply_media_update( array $payload ) {
		global $wpdb;
		$id = isset( $payload['attachment_id'] ) ? (int) $payload['attachment_id'] : 0;
		$op = isset( $payload['__operationId'] ) ? (string) $payload['__operationId'] : '';
		$action = isset( $payload['action'] ) ? (string) $payload['action'] : '';
		if ( ! $id || ! $op || ! in_array( $action, array( 'inspect', 'update', 'trash', 'restore' ), true ) ) throw new Exception( 'invalid_media_command' );
		if ( ! POS_Connector_Queue::maybe_install() ) throw new Exception( 'media_queue_unavailable' );
		foreach ( array( $wpdb->posts, $wpdb->postmeta, $wpdb->options, POS_Connector_Queue::table_name() ) as $table ) {
			if ( 'innodb' !== strtolower( (string) $wpdb->get_var( $wpdb->prepare( 'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $table ) ) ) ) throw new Exception( 'media_requires_innodb' );
		}
		$lock = self::media_payload_lock( $id );
		if ( '1' !== (string) $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, 5)', $lock ) ) ) throw new Exception( 'media_payload_busy' );
		try {
			if ( false === $wpdb->query( 'START TRANSACTION' ) ) throw new Exception( 'media_transaction_failed' );
			$wpdb->get_var( $wpdb->prepare( "SELECT ID FROM {$wpdb->posts} WHERE ID = %d FOR UPDATE", $id ) );
			clean_post_cache( $id );
			$post = get_post( $id );
			if ( ! $post || 'attachment' !== $post->post_type ) throw new Exception( 'attachment_not_found' );
			$key = '_pos_edit_' . hash( 'sha256', $op );
			if ( ! get_post_meta( $id, $key, true ) ) {
				if ( 'inspect' !== $action && (string) get_post_meta( $id, '_pos_content_revision', true ) !== (string) $payload['expected_revision'] ) throw new Exception( 'media_revision_conflict' );
				if ( 'trash' === $action ) {
					if ( ! defined( 'MEDIA_TRASH' ) || ! MEDIA_TRASH || ! defined( 'EMPTY_TRASH_DAYS' ) || EMPTY_TRASH_DAYS <= 0 ) throw new Exception( 'media_trash_unsupported' );
					$usage = self::media_usage( $id );
					if ( $usage['total'] > 0 && empty( $payload['acknowledge_usage'] ) ) throw new Exception( 'media_in_use' );
					if ( 'trash' !== $post->post_status && ! wp_trash_post( $id ) ) throw new Exception( 'media_trash_failed' );
				} elseif ( 'restore' === $action ) {
					if ( 'trash' === $post->post_status && ! wp_untrash_post( $id ) ) throw new Exception( 'media_restore_failed' );
				} elseif ( 'update' === $action ) {
					$fields = isset( $payload['fields'] ) && is_array( $payload['fields'] ) ? $payload['fields'] : array();
					$data = array( 'ID' => $id );
					foreach ( array( 'title' => 'post_title', 'caption' => 'post_excerpt', 'description' => 'post_content' ) as $input => $field ) {
						if ( isset( $fields[ $input ] ) ) $data[ $field ] = sanitize_textarea_field( $fields[ $input ] );
					}
					if ( isset( $fields['alt_text'] ) ) update_post_meta( $id, '_wp_attachment_image_alt', sanitize_text_field( $fields['alt_text'] ) );
					if ( is_wp_error( wp_update_post( $data, true ) ) ) throw new Exception( 'media_update_failed' );
				}
				update_post_meta( $id, $key, 'done' );
			}
			self::enqueue_media_confirmation( $id, true );
			if ( false === $wpdb->query( 'COMMIT' ) ) throw new Exception( 'media_commit_failed' );
		} catch ( \Throwable $error ) { $wpdb->query( 'ROLLBACK' ); clean_post_cache( $id ); throw $error; }
		finally { $wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock ) ); }
	}

	private static function enqueue_media_confirmation( $attachment_id, $include_usage = false ) {
		$post = get_post( $attachment_id );
		if ( ! $post || 'attachment' !== $post->post_type ) {
			throw new Exception( 'media_confirmation_attachment_missing' );
		}
		$queued = self::safe_enqueue_callable(
			'content.updated',
			'attachment:' . $attachment_id,
			static function () use ( $post, $include_usage ) {
				$payload = self::content_payload( $post );
				if ( $include_usage ) $payload['usage'] = self::media_usage( $post->ID );
				return $payload;
			}
		);
		if ( ! $queued ) {
			throw new Exception( 'media_confirmation_enqueue_failed' );
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

	/**
	 * Keyset (cursor) paging for the export sweeps.
	 *
	 * The sweeps used to page with OFFSET (`page` / `paged`): on a live
	 * store, a row inserted or deleted mid-sweep shifts every later page,
	 * so rows are skipped or queued twice — and each page costs the
	 * database a scan of everything before it. Ordering by ID and resuming
	 * from the last ID seen (`ID > cursor`) makes each batch begin exactly
	 * where the previous one ended, whatever changed underneath, at a
	 * constant cost per batch. The filter is attached only around the one
	 * query it belongs to, so nothing else (payload builders included) can
	 * wander into it. Orders keyset on their modified timestamp instead —
	 * see export_orders().
	 */
	private static $export_id_cursor = 0;

	/** `posts_where` half of the cursor: products and content. */
	public static function export_id_cursor_where( $where ) {
		global $wpdb;
		return $where . $wpdb->prepare( " AND {$wpdb->posts}.ID > %d", self::$export_id_cursor ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name only; the value is prepared.
	}

	/** `pre_user_query` half of the cursor: the customer book. */
	public static function export_user_id_cursor_where( $query ) {
		global $wpdb;
		$query->query_where .= $wpdb->prepare( " AND {$wpdb->users}.ID > %d", self::$export_id_cursor ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name only; the value is prepared.
	}

	private static function product_export_state_key( $sync_id ) {
		return 'pos_connector_product_export_' . $sync_id;
	}

	/**
	 * Exports that have started and not finished: run id => saved state.
	 * The saved place is the whole truth about one — a cron event that died,
	 * or a continuation that never fired, loses nothing.
	 */
	public static function pending_product_exports() {
		global $wpdb;
		$prefix = 'pos_connector_product_export_';
		$names  = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s",
				$wpdb->esc_like( $prefix ) . '%'
			)
		);
		$out = array();
		foreach ( (array) $names as $name ) {
			$sync_id = substr( (string) $name, strlen( $prefix ) );
			$state   = get_option( (string) $name, false );
			if ( preg_match( '/\A[a-f0-9-]{36}\z/i', $sync_id ) && is_array( $state ) ) {
				$out[ $sync_id ] = $state;
			}
		}
		return $out;
	}

	/** One single event per run id; never two. */
	private static function schedule_product_export_continuation( $sync_id, $delay = 5 ) {
		$args = array( (string) $sync_id );
		if ( ! wp_next_scheduled( POS_CONNECTOR_CRON_PRODUCT_EXPORT, $args ) ) {
			if ( false === wp_schedule_single_event( time() + max( 1, (int) $delay ), POS_CONNECTOR_CRON_PRODUCT_EXPORT, $args ) ) {
				POS_Connector_Log::error( 'export', 'product_export_continuation_schedule_failed' );
			}
		}
	}

	private static function schedule_pending_product_exports() {
		foreach ( array_keys( self::pending_product_exports() ) as $sync_id ) {
			self::schedule_product_export_continuation( $sync_id );
		}
	}

	/** Continue a chunked catalogue export from its saved place. */
	public static function continue_product_export( $sync_id ) {
		$sync_id = (string) $sync_id;
		if ( ! preg_match( '/\A[a-f0-9-]{36}\z/i', $sync_id ) || ! is_array( get_option( self::product_export_state_key( $sync_id ), false ) ) ) {
			return;
		}
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) || empty( $settings['sync_products'] ) ) {
			return;
		}
		$gate = self::gate();
		if ( true !== $gate['state'] ) {
			// Paused or unreachable: the saved place stays, and the fast lane
			// (`schedule_pending_product_exports()`) puts the event back.
			return;
		}
		self::export_products( $sync_id );
	}

	/**
	 * Queue the whole catalogue as ordinary product events — in slices.
	 *
	 * One call reads for at most EXPORT_TIME_BUDGET_SECONDS, saves where it
	 * stopped (a keyset cursor, like every other sweep here) and schedules the
	 * rest as a single cron event. The catalogue is therefore read over
	 * several ticks; the completion marker is queued only after the last
	 * slice, behind every product, so the app advances its watermark exactly
	 * as it did when this ran in one request.
	 *
	 * Calling it while an export is already in flight joins that export — a
	 * button pressed twice, or the hourly sweep arriving before the last one
	 * finished, must not start a second pass over the same catalogue.
	 *
	 * @param string|null $sync_id Resume this run (cron continuation), or start/join one.
	 * @param bool        $defer   Create the run but leave the first slice to a cron event
	 *                             (callers that are themselves inside a time budget).
	 * @return int Products and variations queued so far.
	 */
	public static function export_products( $sync_id = null, $defer = false ) {
		if ( null === $sync_id || '' === $sync_id ) {
			foreach ( self::pending_product_exports() as $running_id => $running ) {
				if ( time() - (int) ( isset( $running['started_at'] ) ? $running['started_at'] : 0 ) < self::PRODUCT_EXPORT_MAX_AGE_SECONDS ) {
					self::schedule_product_export_continuation( $running_id );
					return (int) $running['parents'] + (int) $running['variations'];
				}
				delete_option( self::product_export_state_key( $running_id ) );
			}
			$sync_id = wp_generate_uuid4();
			$state   = array(
				'phase'      => 'parents',
				'cursor'     => 0,
				'parents'    => 0,
				'variations' => 0,
				// Variation-like rows met in the parents pass; queued after the
				// variation pass so parents still land before any variation.
				'deferred'   => array(),
				'started_at' => time(),
			);
			if ( ! add_option( self::product_export_state_key( $sync_id ), $state, '', 'no' ) ) {
				POS_Connector_Log::error( 'export', 'product_export_state_create_failed' );
				return 0;
			}
			if ( $defer ) {
				self::schedule_product_export_continuation( $sync_id, 1 );
				return 0;
			}
		} else {
			$sync_id = (string) $sync_id;
			if ( ! preg_match( '/\A[a-f0-9-]{36}\z/i', $sync_id ) ) {
				return 0;
			}
			$state = get_option( self::product_export_state_key( $sync_id ), false );
			if ( ! is_array( $state ) ) {
				return 0;
			}
		}

		// One reader at a time: a cron continuation and `wp pos-connector export
		// products` must not both walk the same cursor.
		$store = new POS_Connector_Option_Lock_Store();
		$token = POS_Connector_Lock::acquire( 'product_export', self::EXPORT_TIME_BUDGET_SECONDS + 90, time(), $store );
		if ( false === $token ) {
			return (int) $state['parents'] + (int) $state['variations'];
		}
		$state_key = self::product_export_state_key( $sync_id );
		$started   = microtime( true );
		try {
			while ( 'done' !== $state['phase'] ) {
				$state = self::product_export_step( $state, $sync_id );
				if ( 'done' === $state['phase'] ) {
					delete_option( $state_key );
					break;
				}
				// The place is saved after every slice, so a request killed mid-run
				// repeats at most one slice (queue rows coalesce by topic+id).
				update_option( $state_key, $state, false );
				if ( ( microtime( true ) - $started ) >= self::EXPORT_TIME_BUDGET_SECONDS ) {
					self::schedule_product_export_continuation( $sync_id );
					POS_Connector_Log::info(
						'export',
						sprintf( 'کاتالوگ در حال ارسال است؛ %d محصول و %d تنوع تاکنون در صف قرار گرفت.', (int) $state['parents'], (int) $state['variations'] )
					);
					return (int) $state['parents'] + (int) $state['variations'];
				}
			}
		} finally {
			POS_Connector_Lock::release( 'product_export', $token, $store );
		}

		POS_Connector_Log::info(
			'export',
			sprintf( '%d محصول و %d تنوع در صف ارسال قرار گرفت.', (int) $state['parents'], (int) $state['variations'] )
		);
		return (int) $state['parents'] + (int) $state['variations'];
	}

	/**
	 * Advance a catalogue export by one query's worth of work and return the new state.
	 *
	 * Phases, in order: `parents` (every product of every type and every
	 * non-trashed status), `variations` (the sellable children under variable
	 * products), `deferred` (variation-like rows an extension's type put in the
	 * first pass), `finish` (taxonomy snapshot, completion marker).
	 *
	 * No `type` filter in the parents pass on purpose. 1.0.x asked for
	 * `array( 'simple', 'variable' )`, which silently dropped grouped, external
	 * and every extension's own product type out of the catalogue. No
	 * `publish`-only filter either, since 1.3.0: the app's own REST pull reads
	 * `/products` with the store's default status filter — `any` — so a
	 * plugin-connected store whose owner keeps drafts or private products was
	 * exporting a smaller catalogue than the same store connected with consumer
	 * keys. Trash and auto-drafts stay out: they are not catalogue rows anywhere.
	 */
	private static function product_export_step( array $state, $sync_id ) {
		switch ( $state['phase'] ) {
			case 'parents':
				self::$export_id_cursor = (int) $state['cursor'];
				add_filter( 'posts_where', array( __CLASS__, 'export_id_cursor_where' ) );
				$products = wc_get_products(
					array(
						'limit'   => self::PRODUCT_EXPORT_BATCH,
						'status'  => array( 'publish', 'draft', 'pending', 'private', 'future' ),
						'orderby' => 'ID',
						'order'   => 'ASC',
						'return'  => 'objects',
					)
				);
				remove_filter( 'posts_where', array( __CLASS__, 'export_id_cursor_where' ) );
				foreach ( $products as $product ) {
					$state['cursor'] = max( (int) $state['cursor'], (int) $product->get_id() );
					// A variation is a `product_variation` post, so it is not in
					// this query — but a plugin that registers its own variation-
					// like type can be, so filter by the type, not by assumption.
					if ( 'variation' === $product->get_type() ) {
						$state['deferred'][] = (int) $product->get_id();
					} else {
						POS_Connector_Queue::enqueue( 'product.updated', $product->get_id(), self::product_payload( $product ) );
						++$state['parents'];
					}
				}
				if ( count( $products ) < self::PRODUCT_EXPORT_BATCH ) {
					$state['phase']  = 'variations';
					$state['cursor'] = 0;
				}
				return $state;

			case 'variations':
				self::$export_id_cursor = (int) $state['cursor'];
				add_filter( 'posts_where', array( __CLASS__, 'export_id_cursor_where' ) );
				$children = wc_get_products(
					array(
						'limit'   => self::PRODUCT_EXPORT_BATCH,
						'status'  => 'publish',
						'type'    => 'variation',
						'orderby' => 'ID',
						'order'   => 'ASC',
						'return'  => 'objects',
					)
				);
				remove_filter( 'posts_where', array( __CLASS__, 'export_id_cursor_where' ) );
				foreach ( $children as $variation ) {
					$state['cursor'] = max( (int) $state['cursor'], (int) $variation->get_id() );
					POS_Connector_Queue::enqueue( 'product.updated', $variation->get_id(), self::product_payload( $variation ) );
					++$state['variations'];
				}
				if ( count( $children ) < self::PRODUCT_EXPORT_BATCH ) {
					$state['phase'] = 'deferred';
				}
				return $state;

			case 'deferred':
				// Taken in slices too: the list is normally empty, but it is
				// whatever a third-party product type put there.
				$slice = array_splice( $state['deferred'], 0, self::PRODUCT_EXPORT_BATCH );
				foreach ( $slice as $variation_id ) {
					$product = wc_get_product( $variation_id );
					if ( $product ) {
						POS_Connector_Queue::enqueue( 'product.updated', $product->get_id(), self::product_payload( $product ) );
						++$state['variations'];
					}
				}
				if ( empty( $state['deferred'] ) ) {
					$state['phase'] = 'finish';
				}
				return $state;

			case 'finish':
			default:
				$taxonomy_terms = self::enqueue_taxonomy_snapshot();
				POS_Connector_Queue::enqueue(
					'catalogue.sync_completed',
					$sync_id,
					array(
						'id'             => $sync_id,
						'type'           => 'catalogue',
						'products'       => (int) $state['parents'],
						'variations'     => (int) $state['variations'],
						'taxonomy_terms' => $taxonomy_terms,
					)
				);
				$state['phase'] = 'done';
				return $state;
		}
	}

	/**
	 * Run one queued button press (the callback of POS_CONNECTOR_CRON_MANUAL_JOB).
	 *
	 * The admin buttons used to do this work inside the web request, which
	 * LiteSpeed or PHP's own limit ended on a large store. They now schedule a
	 * single event and return; the same guards the button checks are checked
	 * again here, because the settings can change between the press and the run.
	 */
	public static function run_manual_job( $kind ) {
		$kind     = (string) $kind;
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) || ! pos_connector_woocommerce_active() ) {
			return;
		}
		switch ( $kind ) {
			case 'sync':
				self::run();
				return;
			case 'products':
				self::run_resync_products();
				return;
			case 'orders':
				self::run_resync_orders();
				return;
			case 'customers':
				self::run_resync_customers();
				return;
			case 'content':
				self::run_resync_content();
				return;
		}
	}

	/**
	 * Re-send orders changed in the last `$days` days, oldest changed first.
	 *
	 * `wc_get_orders` with `date_modified` is the whole point: it finds the
	 * orders that changed *since the last sweep*, including the ones whose
	 * hooks never fired. Bounded by ORDER_SWEEP_LIMIT *per batch* and keyset-paged so
	 * a store with a busy week is not silently truncated to the first 200 —
	 * the cap now bounds a single batch; the sweep walks batches until the window
	 * is drained or the hard ceiling is reached, and the log says when a
	 * ceiling was hit so the next sweep's shorter window still backfills.
	 */
	public static function export_orders( $days = 7 ) {
		$days  = max( 1, min( 365, (int) $days ) );
		$after = gmdate( 'Y-m-d H:i:s', time() - ( $days * DAY_IN_SECONDS ) );

		// Keyset over (date_modified, id): each batch resumes at the last
		// modified second seen (`>=`), and re-reads of that boundary second
		// are recognised by id and skipped — so orders changed mid-sweep
		// cannot shift the walk the way OFFSET paging let them. The cursor
		// is only sound if the store really returns modified-ascending
		// rows, so every batch is checked: one out-of-order row — or a full
		// page of orders sharing a single modified second, which the id
		// tiebreak cannot step over — abandons the cursor and the sweep
		// restarts with the old offset walk. Rows already queued coalesce
		// by (topic, remote_id), so re-walking costs no duplicates.
		$enqueued      = 0;
		$batches       = 0;
		$boundary_ts   = strtotime( $after );
		$boundary_seen = array();
		$cursor_failed = false;
		$ceiling_hit   = false;
		while ( true ) {
			$orders = wc_get_orders(
				array(
					'limit'         => self::ORDER_SWEEP_LIMIT,
					'date_modified' => '>=' . gmdate( 'Y-m-d H:i:s', $boundary_ts ),
					'orderby'       => 'date_modified',
					'order'         => 'ASC',
					// Refunds and subscriptions are not orders; drafts and trashed
					// rows are not sales.
					'status'        => array_keys( wc_get_order_statuses() ),
					'return'        => 'objects',
				)
			);
			if ( ! $orders ) {
				break;
			}
			$fresh       = 0;
			$previous_ts = null;
			foreach ( $orders as $order ) {
				$modified = $order->get_date_modified();
				$ts       = $modified ? $modified->getTimestamp() : $boundary_ts;
				if ( null !== $previous_ts && $ts < $previous_ts ) {
					$cursor_failed = true;
					break;
				}
				$previous_ts = $ts;
				$order_id    = (int) $order->get_id();
				if ( $ts < $boundary_ts || ( $ts === $boundary_ts && isset( $boundary_seen[ $order_id ] ) ) ) {
					continue;
				}
				POS_Connector_Queue::enqueue( 'order.updated', $order->get_id(), self::order_payload( $order ) );
				++$enqueued;
				++$fresh;
				if ( $ts !== $boundary_ts ) {
					$boundary_ts   = $ts;
					$boundary_seen = array();
				}
				$boundary_seen[ $order_id ] = true;
			}
			if ( $cursor_failed ) {
				break;
			}
			if ( count( $orders ) < self::ORDER_SWEEP_LIMIT ) {
				break;
			}
			if ( 0 === $fresh ) {
				$cursor_failed = true;
				break;
			}
			// Hard ceiling: 100 batches of the page size (20k orders) keeps
			// one cron run finite on a runaway backlog; the next sweep
			// drains more.
			if ( ++$batches >= 100 ) {
				$ceiling_hit = true;
				break;
			}
		}

		if ( $cursor_failed ) {
			POS_Connector_Log::info(
				'export',
				'پیمایش کلیدی سفارش‌ها قابل اتکا نبود؛ پیمایش صفحه‌ای از ابتدا انجام شد.'
			);
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
						'status'        => array_keys( wc_get_order_statuses() ),
						'return'        => 'objects',
					)
				);
				foreach ( $orders as $order ) {
					POS_Connector_Queue::enqueue( 'order.updated', $order->get_id(), self::order_payload( $order ) );
					++$enqueued;
				}
				++$page;
			} while ( count( $orders ) === self::ORDER_SWEEP_LIMIT && $page <= 100 );
			$ceiling_hit = $page > 100;
		}

		if ( $ceiling_hit ) {
			POS_Connector_Log::info(
				'export',
				'سقف پیمایش سفارش‌ها در این اجرا پر شد؛ باقی‌مانده در اجرای بعدی ارسال می‌شود.'
			);
		}

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

	private static function customer_export_state_key( $sync_id ) {
		return 'pos_connector_customer_export_' . $sync_id;
	}

	/**
	 * Find one bounded, keyset-paginated batch from the union of Woo customer
	 * roles and users with a recorded order. The cursor is a user id rather than
	 * an offset, so inserts/deletes during the export cannot shift later pages.
	 */
	private static function customer_export_user_ids_after( $after_id, $limit ) {
		global $wpdb;
		$capabilities_key = $wpdb->get_blog_prefix() . 'capabilities';
		$sql              = "SELECT DISTINCT users.ID
			FROM {$wpdb->users} AS users
			LEFT JOIN {$wpdb->usermeta} AS capabilities
				ON capabilities.user_id = users.ID AND capabilities.meta_key = %s
			LEFT JOIN {$wpdb->usermeta} AS last_order
				ON last_order.user_id = users.ID AND last_order.meta_key = %s
			LEFT JOIN {$wpdb->usermeta} AS order_count
				ON order_count.user_id = users.ID AND order_count.meta_key = %s
			WHERE users.ID > %d
				AND (capabilities.meta_value LIKE %s OR capabilities.meta_value LIKE %s
					OR last_order.umeta_id IS NOT NULL OR order_count.meta_value REGEXP '^[1-9][0-9]*$')
			ORDER BY users.ID ASC
			LIMIT %d";
		$prepared         = $wpdb->prepare(
			$sql,
				$capabilities_key,
				'_last_order',
				'_order_count',
				absint( $after_id ),
			'%"customer"%',
			'%"subscriber"%',
			max( 1, min( 500, (int) $limit ) )
		);
		return array_map( 'absint', (array) $wpdb->get_col( $prepared ) );
	}

	/** Schedule one resumable slice without creating duplicate cron events. */
	private static function schedule_customer_export_continuation( $sync_id ) {
		$hook = 'pos_connector_customer_export_continue';
		$args = array( (string) $sync_id );
		if ( ! wp_next_scheduled( $hook, $args ) ) {
			$scheduled = wp_schedule_single_event( time() + 15, $hook, $args );
			if ( false === $scheduled ) {
				POS_Connector_Log::error( 'export', 'customer_export_continuation_schedule_failed' );
			}
		}
	}

	/** Re-arm persisted exports after a pause or a missed WP-Cron invocation. */
	private static function schedule_pending_customer_exports() {
		global $wpdb;
		$prefix       = 'pos_connector_customer_export_';
		$option_names = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s",
				$wpdb->esc_like( $prefix ) . '%'
			)
		);
		foreach ( (array) $option_names as $option_name ) {
			$sync_id = substr( (string) $option_name, strlen( $prefix ) );
			if ( preg_match( '/\A[a-f0-9-]{36}\z/i', $sync_id ) ) {
				self::schedule_customer_export_continuation( $sync_id );
			}
		}
	}

	/** Continue a persisted export from its keyset cursor. */
	public static function continue_customer_export( $sync_id ) {
		$sync_id = (string) $sync_id;
		if ( ! preg_match( '/\A[a-f0-9-]{36}\z/i', $sync_id ) || ! is_array( get_option( self::customer_export_state_key( $sync_id ), false ) ) ) {
			return;
		}
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) || empty( $settings['sync_customers'] ) ) {
			return;
		}
		$gate = self::gate();
		if ( true !== $gate['state'] ) {
			return;
		}
		self::export_customers( $sync_id );
		self::run( $gate );
	}

	/**
	 * Export customer snapshots in bounded, resumable batches. Every customer
	 * event is keyed by run id plus remote id, while the completion marker is
	 * queued only after the keyset cursor reaches the end of the population.
	 */
	public static function export_customers( $sync_id = null ) {
		if ( null === $sync_id || '' === $sync_id ) {
			self::schedule_pending_customer_exports();
			$sync_id  = wp_generate_uuid4();
			$state_key = self::customer_export_state_key( $sync_id );
			$state     = array(
				'cursor'          => 0,
				'expected_count'  => 0,
				'queue_failures'  => 0,
			);
			if ( ! add_option( $state_key, $state, '', 'no' ) ) {
				POS_Connector_Log::error( 'export', 'customer_export_state_create_failed' );
				return 0;
			}
		} else {
			$sync_id = (string) $sync_id;
			if ( ! preg_match( '/\A[a-f0-9-]{36}\z/i', $sync_id ) ) {
				return 0;
			}
			$state_key = self::customer_export_state_key( $sync_id );
			$state     = get_option( $state_key, false );
			if ( ! is_array( $state ) ) {
				return 0;
			}
		}

		$batch_size = 250;
		$user_ids   = self::customer_export_user_ids_after( isset( $state['cursor'] ) ? $state['cursor'] : 0, $batch_size );
		if ( empty( $user_ids ) ) {
			$expected_count = max( 0, (int) $state['expected_count'] );
			$marker_id      = POS_Connector_Queue::enqueue(
				'customers.sync_completed',
				$sync_id,
				array(
					'id'       => $sync_id,
					'sync_id'  => $sync_id,
					'type'     => 'customers',
					'count'    => $expected_count,
				)
			);
			if ( ! $marker_id ) {
				POS_Connector_Log::error( 'export', 'customer_export_marker_enqueue_failed' );
				self::schedule_customer_export_continuation( $sync_id );
				return $expected_count;
			}
			delete_option( $state_key );
			POS_Connector_Log::info(
				'export',
				sprintf(
					'%d مشتری در صف ارسال قرار گرفت؛ %d خطای صف.',
					$expected_count,
					max( 0, (int) $state['queue_failures'] )
				)
			);
			return $expected_count;
		}

		foreach ( $user_ids as $user_id ) {
			$customer = new WC_Customer( $user_id );
			if ( $customer->get_id() ) {
				$payload                          = self::customer_payload( $customer );
				$payload['__pos_customer_sync_id'] = $sync_id;
				$queue_id                         = $sync_id . ':' . $customer->get_id();
					$queued                           = POS_Connector_Queue::enqueue( 'customer.updated', $queue_id, $payload );
					if ( ! $queued ) {
						++$state['queue_failures'];
						if ( ! update_option( $state_key, $state, false ) ) {
							POS_Connector_Log::error( 'export', 'customer_export_failure_state_persist_failed' );
						}
						POS_Connector_Log::error( 'export', 'customer_export_row_enqueue_failed' );
						self::schedule_customer_export_continuation( $sync_id );
						return max( 0, (int) $state['expected_count'] );
					}
					++$state['expected_count'];
				}

				// Persist cursor and counts together. If the request dies before this
				// write, the same customer is retried with the same run-specific key.
				$state['cursor'] = (int) $user_id;
				if ( ! update_option( $state_key, $state, false ) ) {
				POS_Connector_Log::error( 'export', 'customer_export_cursor_persist_failed' );
				self::schedule_customer_export_continuation( $sync_id );
				return max( 0, (int) $state['expected_count'] );
			}
		}

		self::schedule_customer_export_continuation( $sync_id );
		POS_Connector_Log::info(
			'export',
			sprintf( 'مجموعهٔ مشتریان در حال ارسال است؛ %d از %d snapshot ثبت شد.', count( $user_ids ), (int) $state['expected_count'] )
		);
		return max( 0, (int) $state['expected_count'] );
	}

	/**
	 * Queue every post, page and media attachment as a content event — the
	 * «همگام‌سازی محتوا» action, and the answer the app's `content_export`
	 * job. Mirrors export_products: keyset batches of 100, every type the manager
	 * shows, queued rather than posted so the events inherit the batch/retry
	 * path.
	 */
	public static function export_content() {
		$count   = 0;
		$sync_id = wp_generate_uuid4();
		// Issue #941: attachments travel as one verified media snapshot, not as content pages.
		self::export_media_snapshot();
		foreach ( array( 'post', 'page' ) as $type ) {
			$cursor  = 0;
			$batches = 0;
			do {
				self::$export_id_cursor = $cursor;
				add_filter( 'posts_where', array( __CLASS__, 'export_id_cursor_where' ) );
				$posts = get_posts(
					array(
						'post_type'      => $type,
						'post_status'    => 'attachment' === $type ? 'inherit' : array( 'publish', 'draft', 'pending', 'private', 'future', 'trash' ),
						'posts_per_page' => 100,
						'orderby'        => 'ID',
						'order'          => 'ASC',
						'no_found_rows'  => true,
					)
				);
				remove_filter( 'posts_where', array( __CLASS__, 'export_id_cursor_where' ) );
				foreach ( $posts as $post ) {
					$cursor = max( $cursor, (int) $post->ID );
					if ( wp_is_post_revision( $post ) || 'auto-draft' === $post->post_status ) {
						continue;
					}
					$content_payload                 = self::content_payload( $post );
					$content_payload['_snapshot_id'] = $sync_id;
					POS_Connector_Queue::enqueue(
						'content.updated',
						$type . ':' . $post->ID,
						$content_payload
					);
					++$count;
				}
			} while ( count( $posts ) === 100 && ++$batches < 500 );
		}
		// This marker is queued after every exported row. The outbound queue is
		// FIFO, so the app only advances its content watermark after the whole
		// snapshot in front of this marker has been accepted.
		POS_Connector_Queue::enqueue(
			'content.sync_completed',
			$sync_id,
			array(
				'id'           => $sync_id,
				'type'         => 'content',
				'count'        => $count,
				'_snapshot_id' => $sync_id,
			)
		);
		POS_Connector_Log::info( 'export', sprintf( '%d محتوای وردپرس در صف ارسال قرار گرفت.', $count ) );
		return $count;
	}

	/** Keyset export: new attachments beyond the captured upper ID belong to a
	 * later generation. No completion marker is emitted after any queue error.
	 */
	private static function export_media_snapshot() {
		global $wpdb;
		if ( ! POS_Connector_Queue::maybe_install() ) throw new Exception( 'media_queue_unavailable' );
		foreach ( array( $wpdb->posts, $wpdb->postmeta, $wpdb->options, POS_Connector_Queue::table_name() ) as $table ) {
			if ( 'innodb' !== strtolower( (string) $wpdb->get_var( $wpdb->prepare( 'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $table ) ) ) ) throw new Exception( 'media_requires_innodb' );
		}
		$id = wp_generate_uuid4();
		$boundary = self::next_content_revision();
		$upper = (int) $wpdb->get_var( "SELECT COALESCE(MAX(ID), 0) FROM {$wpdb->posts} WHERE post_type = 'attachment'" );
		$last = 0; $count = 0;
		do {
			$ids = $wpdb->get_col( $wpdb->prepare( "SELECT ID FROM {$wpdb->posts} WHERE post_type = 'attachment' AND post_status <> 'auto-draft' AND ID > %d AND ID <= %d ORDER BY ID ASC LIMIT 100", $last, $upper ) );
			if ( $wpdb->last_error ) throw new Exception( 'media_snapshot_query_failed' );
			foreach ( $ids as $post_id ) {
				$last = (int) $post_id;
				// Read the row/meta and allocate its revision under the same DB
				// locks. A stale WP object cache must never receive a revision
				// newer than a concurrently committed edit and overwrite it.
				$lock = self::media_payload_lock( $post_id );
				if ( '1' !== (string) $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, 5)', $lock ) ) ) throw new Exception( 'media_payload_busy' );
				try {
					if ( false === $wpdb->query( 'START TRANSACTION' ) ) throw new Exception( 'media_snapshot_transaction_failed' );
					$wpdb->get_var( $wpdb->prepare( "SELECT ID FROM {$wpdb->posts} WHERE ID = %d FOR UPDATE", $post_id ) );
					$wpdb->get_col( $wpdb->prepare( "SELECT meta_id FROM {$wpdb->postmeta} WHERE post_id = %d FOR UPDATE", $post_id ) );
					if ( $wpdb->last_error ) throw new Exception( 'media_snapshot_lock_failed' );
					clean_post_cache( $post_id );
					$post = get_post( $post_id );
					if ( ! $post ) { $wpdb->query( 'ROLLBACK' ); continue; }
					if ( $count >= 500000 ) throw new Exception( 'media_snapshot_limit' );
					$payload = self::content_payload( $post );
					$payload['snapshot'] = array( 'id' => $id, 'boundary' => $boundary, 'index' => $count + 1 );
					// Generation-specific keys cannot coalesce with live events.
					if ( ! POS_Connector_Queue::enqueue( 'content.updated', 'snapshot:' . $id . ':' . $post_id, $payload ) ) throw new Exception( 'media_snapshot_enqueue_failed' );
					if ( false === $wpdb->query( 'COMMIT' ) ) throw new Exception( 'media_snapshot_commit_failed' );
					++$count;
				} catch ( \Throwable $error ) {
					$wpdb->query( 'ROLLBACK' ); clean_post_cache( $post_id ); throw $error;
				} finally { $wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock ) ); }
			}
		} while ( count( $ids ) === 100 );
		if ( ! POS_Connector_Queue::enqueue( 'content.media_snapshot_completed', $id, array( 'snapshot' => array( 'id' => $id, 'boundary' => $boundary, 'count' => $count ) ) ) ) throw new Exception( 'media_snapshot_enqueue_failed' );
	}

	/** The customer sweep: re-queue the whole customer book. */
	public static function run_resync_customers() {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) || empty( $settings['sync_customers'] ) ) {
			return;
		}
		$gate = self::gate();
		if ( true !== $gate['state'] ) {
			return;
		}
		$settings = pos_connector_settings();
		if ( empty( $settings['sync_customers'] ) ) {
			return;
		}
		self::export_customers();
		pos_connector_update_settings( array( 'last_customers_sweep_at' => current_time( 'mysql', true ) ) );
		self::run( $gate );
	}

	/** The content sweep: re-queue posts, pages and media. */
	public static function run_resync_content() {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) ) {
			return;
		}
		$gate = self::gate();
		if ( true !== $gate['state'] ) {
			return;
		}
		self::export_content();
		pos_connector_update_settings( array( 'last_content_sweep_at' => current_time( 'mysql', true ) ) );
		self::run( $gate );
	}
}
