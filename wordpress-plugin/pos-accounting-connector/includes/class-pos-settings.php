<?php
/**
 * The admin-post action handlers behind the «بیزامیز» screens.
 *
 * The screens themselves live in class-pos-admin.php (the top-level menu:
 * وضعیت، اتصال، همگام‌سازی، صف و خطاها، عیب‌یابی، به‌روزرسانی). This class keeps
 * the nonce-protected `admin_post_*` handlers those screens submit to — save,
 * test, manual sync, retries, the four resync sweeps and the schedule form.
 * Since 1.6.19 the sync and resync buttons only schedule a cron event and return;
 * the work runs in POS_Connector_Sync::run_manual_job().
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
		// #1206 P0: prove the scheduler runs, without touching store data.
		add_action( 'admin_post_pos_connector_cron_probe', array( __CLASS__, 'handle_cron_probe' ) );
	}

	/**
	 * Queue a cron probe and return immediately.
	 *
	 * Deliberately makes no claim and syncs nothing: the answer arrives when a
	 * separate scheduler invocation runs the event, which the Diagnostics screen
	 * then shows stage by stage. No `precondition()` here — a store whose sync is
	 * paused or whose WooCommerce is off still has a cron to check, and the probe
	 * changes no store data.
	 */
	public static function handle_cron_probe() {
		self::guard( 'pos_connector_cron_probe' );
		if ( empty( pos_connector_settings()['enabled'] ) ) {
			self::redirect_back( 'disabled' );
		}
		$probe = POS_Connector_Sync::schedule_cron_probe( 'admin' );
		self::redirect_back( empty( $probe['error'] ) ? 'probe_queued' : 'probe_queue_failed' );
	}


	private static function guard( $action ) {
		if ( ! current_user_can( pos_connector_admin_capability() ) ) {
			wp_die( esc_html__( 'دسترسی مجاز نیست.', 'pos-accounting-connector' ) );
		}
		check_admin_referer( $action );
	}

	/**
	 * A specific sentence for the notice the next screen shows — the number of
	 * seconds a clock is out, the address the app expected. Kept server-side,
	 * per user, for one minute and shown once; carrying it in the URL would let
	 * a crafted link put any text it likes in an admin notice.
	 */
	public static function flash_detail( $detail ) {
		if ( '' !== (string) $detail ) {
			set_transient( 'pos_connector_notice_detail_' . get_current_user_id(), (string) $detail, MINUTE_IN_SECONDS );
		}
	}

	/**
	 * Back to the screen the form was on (its referer's `page`), or the
	 * dashboard when the referer is not one of ours.
	 */
	private static function redirect_back( $notice, $detail = '' ) {
		self::flash_detail( $detail );
		$page = POS_Connector_Health::page_from_referer( wp_get_referer(), POS_Connector_Admin::page_slugs(), self::PAGE_SLUG );
		wp_safe_redirect(
			add_query_arg(
				array(
					'page'       => $page,
					'pos_notice' => rawurlencode( $notice ),
				),
				admin_url( 'admin.php' )
			)
		);
		exit;
	}

	/**
	 * What every button that moves data checks first, in one place, so no
	 * button can forget one of them. Returns the notice to show, or '' when
	 * the button may go ahead.
	 *
	 * «Paused» is the last answer the app gave (the buttons no longer make a
	 * network call of their own); the job re-asks when it actually runs.
	 *
	 * @param string $domain products | orders | customers | content | sync.
	 */
	private static function precondition( $domain ) {
		$settings = pos_connector_settings();
		if ( empty( $settings['base_url'] ) || empty( $settings['token'] ) ) {
			return 'test_not_configured';
		}
		if ( empty( $settings['enabled'] ) ) {
			return 'disabled';
		}
		if ( ! pos_connector_woocommerce_active() ) {
			return 'woo_missing';
		}
		$toggles = array(
			'products'  => 'sync_products',
			'orders'    => 'sync_orders',
			'customers' => 'sync_customers',
		);
		if ( isset( $toggles[ $domain ] ) && empty( $settings[ $toggles[ $domain ] ] ) ) {
			return $domain . '_disabled';
		}
		// «اجرای سریع» is how a pause gets noticed as lifted, so it is never
		// refused for one.
		if ( 'sync' !== $domain && is_array( $settings['last_run_stats'] ) && ! empty( $settings['last_run_stats']['paused'] ) ) {
			return 'paused';
		}
		return '';
	}

	/**
	 * Schedule a button's work as one cron event and return. Heavy work
	 * (`run()`, a catalogue export) used to run inside this request, which
	 * LiteSpeed or PHP's time limit ends on a large store.
	 *
	 * @return bool False when WordPress refused to schedule the event.
	 */
	private static function queue_job( $kind ) {
		$args = array( (string) $kind );
		if ( ! wp_next_scheduled( POS_CONNECTOR_CRON_MANUAL_JOB, $args ) ) {
			if ( false === wp_schedule_single_event( time(), POS_CONNECTOR_CRON_MANUAL_JOB, $args ) ) {
				return false;
			}
		}
		// On WP-Cron, ask WordPress to run it now; with a system crontab the
		// next tick picks it up.
		if ( ! pos_connector_uses_system_cron() && function_exists( 'spawn_cron' ) ) {
			spawn_cron();
		}
		return true;
	}

	private static function queue_and_redirect( $kind, $notice ) {
		if ( ! self::queue_job( $kind ) ) {
			self::redirect_back( 'queue_failed' );
		}
		POS_Connector_Log::info( 'queue', sprintf( 'کار «%s» برای اجرا در کرون زمان‌بندی شد.', $kind ) );
		self::redirect_back( $notice );
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
		// The stale-cron clock starts when the connection becomes usable.
		$before = pos_connector_settings();
		if ( $enabled && ( empty( $before['enabled'] ) || '' === $before['armed_at'] ) ) {
			$changes['armed_at'] = current_time( 'mysql', true );
		}

		pos_connector_update_settings( $changes );
		POS_Connector_Log::info( 'settings', 'تنظیمات ذخیره شد.' );
		self::redirect_back( 'saved' );
	}

	/**
	 * «آزمایش اتصال»: a signed ping that also says what is wrong, not just
	 * whether something is.
	 *
	 * It proves the address, the token, the signature and the clock — and now
	 * also reports a paused connection, a site address that differs from the
	 * one the app has on file, and how far this server's clock is from the
	 * app's. It never touches the «last sync» time: a ping that works says
	 * nothing about whether the cron does (the field it writes is its own).
	 */
	public static function handle_test() {
		self::guard( 'pos_connector_test' );

		$client = POS_Connector_Client::from_settings();
		if ( ! $client ) {
			self::redirect_back( 'test_not_configured' );
		}

		$response = $client->post(
			'/api/integrations/wordpress/ping',
			array(
				'siteUrl'       => home_url(),
				'pluginVersion' => POS_CONNECTOR_VERSION,
			)
		);
		$result = POS_Connector_Health::interpret_ping( $response, time() );

		if ( $response['ok'] ) {
			pos_connector_update_settings( array( 'last_ping_ok_at' => current_time( 'mysql', true ) ) );
			POS_Connector_Log::info( 'test', 'اتصال برقرار است.' );
			self::redirect_back( $result['notice'], $result['detail'] );
		}

		$message = POS_Connector_Client::explain( $response['error'] );
		pos_connector_update_settings( array( 'last_error' => $message ) );
		POS_Connector_Log::error( 'test', $message );
		// An unexplained code is shown as the code; an explained one as its sentence.
		self::redirect_back( $result['notice'], 'test_failed' === $result['notice'] ? $message : $result['detail'] );
	}

	public static function handle_sync_now() {
		self::guard( 'pos_connector_sync_now' );
		$blocked = self::precondition( 'sync' );
		if ( '' !== $blocked ) {
			self::redirect_back( $blocked );
		}
		self::queue_and_redirect( 'sync', 'sync_queued' );
	}

	public static function handle_retry() {
		self::guard( 'pos_connector_retry' );
		$count = POS_Connector_Queue::retry_failed();
		POS_Connector_Log::info( 'retry', sprintf( '%d رویداد دوباره در صف قرار گرفت.', $count ) );
		self::redirect_back( $count > 0 ? 'retried' : 'nothing_to_retry' );
	}

	public static function handle_resync_products() {
		self::guard( 'pos_connector_resync_products' );
		$blocked = self::precondition( 'products' );
		if ( '' !== $blocked ) {
			self::redirect_back( $blocked );
		}
		self::queue_and_redirect( 'products', 'products_queued' );
	}

	public static function handle_resync_orders() {
		self::guard( 'pos_connector_resync_orders' );
		$blocked = self::precondition( 'orders' );
		if ( '' !== $blocked ) {
			self::redirect_back( $blocked );
		}
		self::queue_and_redirect( 'orders', 'orders_queued' );
	}

	public static function handle_resync_customers() {
		self::guard( 'pos_connector_resync_customers' );
		$blocked = self::precondition( 'customers' );
		if ( '' !== $blocked ) {
			self::redirect_back( $blocked );
		}
		self::queue_and_redirect( 'customers', 'customers_queued' );
	}

	public static function handle_resync_content() {
		self::guard( 'pos_connector_resync_content' );
		$blocked = self::precondition( 'content' );
		if ( '' !== $blocked ) {
			self::redirect_back( $blocked );
		}
		self::queue_and_redirect( 'content', 'content_queued' );
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
}
