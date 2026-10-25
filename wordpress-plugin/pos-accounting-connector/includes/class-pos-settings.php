<?php
/**
 * The admin-post action handlers behind the «بیزامیز» screens.
 *
 * The screens themselves live in class-pos-admin.php (the top-level menu:
 * وضعیت، اتصال، همگام‌سازی، صف و خطاها، عیب‌یابی، به‌روزرسانی). This class keeps
 * the nonce-protected `admin_post_*` handlers those screens submit to — save,
 * test, manual sync, retries, the four resync sweeps and the schedule form.
 * The old single-page WooCommerce-submenu screen this class used to render
 * was removed once the top-level menu shipped; only its action names survive,
 * because they are the forms' contract.
 *
 * Two fields to fill in — address and token — because that is the whole
 * configuration. Everything else about the connection (which entities sync,
 * the store's currency unit) is owned by the accounting dashboard and arrives
 * on each handshake, so there is exactly one place to change any given
 * setting.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Settings {

	/**
	 * Where a handler redirects back to: the top-level «بیزامیز» dashboard,
	 * which shares this slug (POS_Connector_Admin::MENU_SLUG).
	 */
	const PAGE_SLUG = 'pos-connector';

	public static function init() {
		add_action( 'admin_post_pos_connector_save', array( __CLASS__, 'handle_save' ) );
		add_action( 'admin_post_pos_connector_test', array( __CLASS__, 'handle_test' ) );
		add_action( 'admin_post_pos_connector_sync_now', array( __CLASS__, 'handle_sync_now' ) );
		add_action( 'admin_post_pos_connector_retry', array( __CLASS__, 'handle_retry' ) );
		// 1.1.0 — the two scheduled sweeps, runnable by hand. A cron that has
		// never fired is indistinguishable from one that is misconfigured
		// until somebody presses the button and watches what happens.
		add_action( 'admin_post_pos_connector_resync_products', array( __CLASS__, 'handle_resync_products' ) );
		add_action( 'admin_post_pos_connector_resync_orders', array( __CLASS__, 'handle_resync_orders' ) );
		add_action( 'admin_post_pos_connector_resync_customers', array( __CLASS__, 'handle_resync_customers' ) );
		add_action( 'admin_post_pos_connector_resync_content', array( __CLASS__, 'handle_resync_content' ) );
		add_action( 'admin_post_pos_connector_schedule', array( __CLASS__, 'handle_schedule' ) );
	}


	private static function guard( $action ) {
			if ( ! current_user_can( pos_connector_admin_capability() ) ) {
				wp_die( esc_html__( 'دسترسی مجاز نیست.', 'pos-accounting-connector' ) );
			}
		check_admin_referer( $action );
	}

	private static function redirect_back( $notice ) {
		wp_safe_redirect(
			add_query_arg(
				array(
					'page'       => self::PAGE_SLUG,
					'pos_notice' => rawurlencode( $notice ),
				),
				admin_url( 'admin.php' )
			)
		);
		exit;
	}

	public static function handle_save() {
		self::guard( 'pos_connector_save' );

		$base_url = isset( $_POST['base_url'] ) ? esc_url_raw( wp_unslash( $_POST['base_url'] ) ) : '';
		$token    = isset( $_POST['token'] ) ? sanitize_text_field( wp_unslash( $_POST['token'] ) ) : '';
		$enabled  = ! empty( $_POST['enabled'] );

		$changes = array(
			'base_url' => untrailingslashit( $base_url ),
			'enabled'  => $enabled,
		);
		// A blank token field means "leave the stored one alone" — the field is
		// rendered empty (never pre-filled with the secret), so treating blank
		// as "erase" would wipe the credential every time someone toggled a
		// checkbox and pressed save.
		if ( '' !== $token ) {
			$changes['token'] = $token;
		}

		pos_connector_update_settings( $changes );
		POS_Connector_Log::info( 'settings', 'تنظیمات ذخیره شد.' );
		self::redirect_back( 'saved' );
	}

	public static function handle_test() {
		self::guard( 'pos_connector_test' );

		$client = POS_Connector_Client::from_settings();
		if ( ! $client ) {
			self::redirect_back( 'test_not_configured' );
		}

		$response = $client->post( '/api/integrations/wordpress/ping' );
		if ( $response['ok'] ) {
			pos_connector_update_settings(
				array(
					'last_ok_at' => current_time( 'mysql', true ),
					'last_error' => '',
				)
			);
			POS_Connector_Log::info( 'test', 'اتصال برقرار است.' );
			self::redirect_back( 'test_ok' );
		}

		$message = POS_Connector_Client::explain( $response['error'] );
		pos_connector_update_settings( array( 'last_error' => $message ) );
		POS_Connector_Log::error( 'test', $message );
		self::redirect_back( 'test_failed' );
	}

		public static function handle_sync_now() {
			self::guard( 'pos_connector_sync_now' );
			$settings = pos_connector_settings();
			if ( empty( $settings['base_url'] ) || empty( $settings['token'] ) ) {
				self::redirect_back( 'test_not_configured' );
			}
			if ( empty( $settings['enabled'] ) ) {
				self::redirect_back( 'disabled' );
			}
			if ( ! pos_connector_woocommerce_active() ) {
				self::redirect_back( 'woo_missing' );
			}
			$result = POS_Connector_Sync::run();
			if ( is_array( $result ) && ! empty( $result['paused'] ) ) {
				self::redirect_back( 'paused' );
			}
			self::redirect_back( is_array( $result ) ? 'synced' : 'sync_failed' );
		}

		public static function handle_retry() {
			self::guard( 'pos_connector_retry' );
			$count = POS_Connector_Queue::retry_failed();
			POS_Connector_Log::info( 'retry', sprintf( '%d رویداد دوباره در صف قرار گرفت.', $count ) );
			self::redirect_back( $count > 0 ? 'retried' : 'nothing_to_retry' );
		}

		public static function handle_resync_products() {
			self::guard( 'pos_connector_resync_products' );
			$settings = pos_connector_settings();
			if ( empty( $settings['enabled'] ) ) self::redirect_back( 'disabled' );
			if ( empty( $settings['sync_products'] ) ) self::redirect_back( 'products_disabled' );
			if ( ! pos_connector_woocommerce_active() ) self::redirect_back( 'woo_missing' );
			$movement = POS_Connector_Sync::server_allows_data_movement();
			if ( 'paused' === $movement ) self::redirect_back( 'paused' );
			if ( true !== $movement ) self::redirect_back( 'sync_failed' );
			self::queue_products_export();
			self::redirect_back( 'products_queued' );
		}

		public static function handle_resync_orders() {
			self::guard( 'pos_connector_resync_orders' );
			$settings = pos_connector_settings();
			if ( empty( $settings['enabled'] ) ) self::redirect_back( 'disabled' );
			if ( empty( $settings['sync_orders'] ) ) self::redirect_back( 'orders_disabled' );
			if ( ! pos_connector_woocommerce_active() ) self::redirect_back( 'woo_missing' );
			$movement = POS_Connector_Sync::server_allows_data_movement();
			if ( 'paused' === $movement ) self::redirect_back( 'paused' );
			if ( true !== $movement ) self::redirect_back( 'sync_failed' );
			$settings = pos_connector_settings();
			if ( empty( $settings['sync_orders'] ) ) self::redirect_back( 'orders_disabled' );
			$count = POS_Connector_Sync::export_orders( (int) $settings['resync_orders_days'] );
			POS_Connector_Log::info( 'export', sprintf( '%d سفارش در صف ارسال قرار گرفت.', (int) $count ) );
			self::redirect_back( 'orders_queued' );
		}

		public static function handle_resync_customers() {
			self::guard( 'pos_connector_resync_customers' );
			$settings = pos_connector_settings();
			if ( empty( $settings['enabled'] ) ) self::redirect_back( 'disabled' );
			if ( empty( $settings['sync_customers'] ) ) self::redirect_back( 'customers_disabled' );
			if ( ! pos_connector_woocommerce_active() ) self::redirect_back( 'woo_missing' );
			$movement = POS_Connector_Sync::server_allows_data_movement();
			if ( 'paused' === $movement ) self::redirect_back( 'paused' );
			if ( true !== $movement ) self::redirect_back( 'sync_failed' );
			$settings = pos_connector_settings();
			if ( empty( $settings['sync_customers'] ) ) self::redirect_back( 'customers_disabled' );
			$count = POS_Connector_Sync::export_customers();
			POS_Connector_Log::info( 'export', sprintf( '%d مشتری در صف ارسال قرار گرفت.', (int) $count ) );
			self::redirect_back( 'customers_queued' );
		}

		public static function handle_resync_content() {
			self::guard( 'pos_connector_resync_content' );
			$settings = pos_connector_settings();
			if ( empty( $settings['enabled'] ) ) self::redirect_back( 'disabled' );
			$movement = POS_Connector_Sync::server_allows_data_movement();
			if ( 'paused' === $movement ) self::redirect_back( 'paused' );
			if ( true !== $movement ) self::redirect_back( 'sync_failed' );
			$count = POS_Connector_Sync::export_content();
			POS_Connector_Log::info( 'export', sprintf( '%d محتوای وردپرس در صف ارسال قرار گرفت.', (int) $count ) );
			self::redirect_back( 'content_queued' );
		}

	/**
	 * Save the sweep cadences and re-arm WP-Cron to match.
	 *
	 * The re-arm is the part that matters: `wp_schedule_event()` ignores a
	 * changed interval for a hook that is already scheduled, so without the
	 * clear-then-schedule in `pos_connector_schedule_event()` the screen would
	 * show «هر ساعت» while WP-Cron went on firing daily.
	 */
	public static function handle_schedule() {
		self::guard( 'pos_connector_schedule' );

		$products = isset( $_POST['resync_products_schedule'] )
			? sanitize_key( wp_unslash( $_POST['resync_products_schedule'] ) )
			: '';
		$orders = isset( $_POST['resync_orders_schedule'] )
			? sanitize_key( wp_unslash( $_POST['resync_orders_schedule'] ) )
			: '';
		$days = isset( $_POST['resync_orders_days'] ) ? (int) $_POST['resync_orders_days'] : 7;
		$days = max( 1, min( 365, $days ) );

		if ( ! array_key_exists( $products, pos_connector_resync_schedules() ) ) {
			$products = '';
		}
		if ( ! array_key_exists( $orders, pos_connector_order_resync_schedules() ) ) {
			$orders = '';
		}

		pos_connector_update_settings(
			array(
				'resync_products_schedule' => $products,
				'resync_orders_schedule'   => $orders,
				'resync_orders_days'       => $days,
			)
		);
		pos_connector_schedule_event( POS_CONNECTOR_CRON_RESYNC_PRODUCTS, $products );
		pos_connector_schedule_event( POS_CONNECTOR_CRON_RESYNC_ORDERS, $orders );

		POS_Connector_Log::info( 'schedule', 'زمان‌بندی به‌روز شد.' );
		self::redirect_back( 'schedule_saved' );
	}

	/** Queue a catalogue export without waiting for the sweep's turn. */
	private static function queue_products_export() {
		POS_Connector_Sync::export_products();
		pos_connector_update_settings( array( 'last_products_sweep_at' => current_time( 'mysql', true ) ) );
		POS_Connector_Log::info( 'export', 'بازخوانی دستی محصولات در صف قرار گرفت.' );
	}
}
