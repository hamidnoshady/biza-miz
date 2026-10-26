<?php
/**
 * Top-level WordPress admin for the Bizamiz connector.
 *
 * The old implementation lived as one WooCommerce submenu page. This class owns
 * the top-level IA and renders focused sections while class-pos-settings.php
 * keeps the nonce-protected action handlers for backwards compatibility.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Admin {

	const MENU_SLUG = 'pos-connector';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'register_menu' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue_assets' ) );
	}

	private static function sections() {
		return array(
			'dashboard'       => array( 'slug' => self::MENU_SLUG,                  'label' => __( 'وضعیت', 'pos-accounting-connector' ) ),
			'connection'      => array( 'slug' => 'pos-connector-connection',       'label' => __( 'اتصال', 'pos-accounting-connector' ) ),
			'synchronization' => array( 'slug' => 'pos-connector-synchronization',  'label' => __( 'همگام‌سازی', 'pos-accounting-connector' ) ),
			'queue'           => array( 'slug' => 'pos-connector-queue',            'label' => __( 'صف و خطاها', 'pos-accounting-connector' ) ),
			'diagnostics'     => array( 'slug' => 'pos-connector-diagnostics',      'label' => __( 'عیب‌یابی', 'pos-accounting-connector' ) ),
			'updates'         => array( 'slug' => 'pos-connector-updates',          'label' => __( 'به‌روزرسانی', 'pos-accounting-connector' ) ),
		);
	}

	/** Every screen's page slug — what a handler may send the user back to. */
	public static function page_slugs() {
		return array_values( wp_list_pluck( self::sections(), 'slug' ) );
	}

	public static function register_menu() {
		$capability = pos_connector_admin_capability();
		add_menu_page(
			pos_connector_brand() . ' — ' . __( 'اتصال فروشگاه', 'pos-accounting-connector' ),
			pos_connector_brand(),
			$capability,
			self::MENU_SLUG,
			array( __CLASS__, 'render' ),
			'dashicons-store',
			56
		);
		foreach ( self::sections() as $section ) {
			add_submenu_page(
				self::MENU_SLUG,
				$section['label'],
				$section['label'],
				$capability,
				$section['slug'],
				array( __CLASS__, 'render' )
			);
		}
	}

	public static function enqueue_assets( $hook ) {
		if ( false === strpos( (string) $hook, 'pos-connector' ) ) {
			return;
		}
		wp_enqueue_style(
			'pos-connector-admin',
			plugins_url( 'assets/admin.css', POS_CONNECTOR_FILE ),
			array(),
			POS_CONNECTOR_VERSION
		);
		wp_enqueue_script(
			'pos-connector-admin',
			plugins_url( 'assets/admin.js', POS_CONNECTOR_FILE ),
			array(),
			POS_CONNECTOR_VERSION,
			true
		);
	}

	private static function current_section() {
		$page = isset( $_GET['page'] ) ? sanitize_key( wp_unslash( $_GET['page'] ) ) : self::MENU_SLUG;
		foreach ( self::sections() as $key => $section ) {
			if ( $section['slug'] === $page ) {
				return $key;
			}
		}
		return 'dashboard';
	}

	private static function status_badge( $label, $tone = 'neutral' ) {
		return '<span class="pos-badge pos-badge--' . esc_attr( $tone ) . '">' . esc_html( $label ) . '</span>';
	}

	private static function format_time( $value ) {
		return $value ? esc_html( $value ) : '—';
	}

	private static function notice_text( $key ) {
		$map = array(
			'saved'               => array( 'success', __( 'تنظیمات ذخیره شد.', 'pos-accounting-connector' ) ),
			'test_ok'             => array( 'success', __( 'ارتباط با سامانه برقرار است: آدرس، توکن، امضا و ساعت درست‌اند. این آزمایش زمان «آخرین همگام‌سازی» را تغییر نمی‌دهد.', 'pos-accounting-connector' ) ),
			'test_paused'         => array( 'warning', __( 'ارتباط برقرار است، اما اتصال در پنل بیزامیز متوقف شده است؛ تا از‌سرگیری آن، داده‌ای جابه‌جا نمی‌شود.', 'pos-accounting-connector' ) ),
			'test_clock_skew'     => array( 'warning', __( 'ارتباط برقرار است، اما ساعت این سرور با سامانه اختلاف دارد (ثانیه):', 'pos-accounting-connector' ) ),
			'test_stale_timestamp' => array( 'error', __( 'ساعت این سرور با سامانه اختلاف زیادی دارد و درخواست رد شد. ساعت و منطقهٔ زمانی سرور را تنظیم کنید. اختلاف (ثانیه):', 'pos-accounting-connector' ) ),
			'test_site_mismatch'  => array( 'error', __( 'آدرس این وب‌سایت با آدرسی که برای این اتصال در بیزامیز ثبت شده یکی نیست. آدرس ثبت‌شده:', 'pos-accounting-connector' ) ),
			'test_failed'         => array( 'error', __( 'آزمایش اتصال ناموفق بود:', 'pos-accounting-connector' ) ),
			'test_not_configured' => array( 'error', __( 'ابتدا آدرس سامانه و توکن اتصال را وارد کنید.', 'pos-accounting-connector' ) ),
			'sync_queued'         => array( 'success', __( 'همگام‌سازی سریع در صف اجرا قرار گرفت و در اولین اجرای کرون انجام می‌شود؛ نتیجه را در وضعیت ببینید.', 'pos-accounting-connector' ) ),
			'queue_failed'        => array( 'error', __( 'وردپرس نتوانست کار را زمان‌بندی کند. گزارش رویدادها و وضعیت کرون را بررسی کنید.', 'pos-accounting-connector' ) ),
			'disabled'            => array( 'warning', __( 'افزونه به صورت محلی غیرفعال است؛ عملیاتی انجام نشد.', 'pos-accounting-connector' ) ),
			'paused'              => array( 'warning', __( 'همگام‌سازی از سمت پنل بیزامیز متوقف است؛ داده‌ای جابه‌جا نمی‌شود. پس از از‌سرگیری، «اجرای سریع» را بزنید.', 'pos-accounting-connector' ) ),
			'woo_missing'         => array( 'error', __( 'ووکامرس فعال نیست؛ عملیات ووکامرس غیرفعال است.', 'pos-accounting-connector' ) ),
			'nothing_to_retry'    => array( 'info', __( 'رویداد ناموفقی برای تلاش دوباره وجود نداشت.', 'pos-accounting-connector' ) ),
			'products_disabled'   => array( 'warning', __( 'همگام‌سازی محصولات از پنل سامانه غیرفعال است.', 'pos-accounting-connector' ) ),
			'orders_disabled'     => array( 'warning', __( 'همگام‌سازی سفارش‌ها از پنل سامانه غیرفعال است.', 'pos-accounting-connector' ) ),
			'customers_disabled'  => array( 'warning', __( 'همگام‌سازی مشتریان از پنل سامانه غیرفعال است.', 'pos-accounting-connector' ) ),
			'retried'             => array( 'success', __( 'رویدادهای ناموفق دوباره در صف قرار گرفتند.', 'pos-accounting-connector' ) ),
			'products_queued'     => array( 'success', __( 'بازخوانی کاتالوگ در صف اجرا قرار گرفت. در چند نوبت کرون انجام می‌شود؛ پیشرفت را در وضعیت ببینید.', 'pos-accounting-connector' ) ),
			'orders_queued'       => array( 'success', __( 'بازخوانی سفارش‌ها در صف اجرا قرار گرفت و در اولین اجرای کرون انجام می‌شود.', 'pos-accounting-connector' ) ),
			'customers_queued'    => array( 'success', __( 'بازخوانی مشتریان در صف اجرا قرار گرفت و در اولین اجرای کرون انجام می‌شود.', 'pos-accounting-connector' ) ),
			'content_queued'      => array( 'success', __( 'بازخوانی محتوا و رسانه در صف اجرا قرار گرفت و در اولین اجرای کرون انجام می‌شود.', 'pos-accounting-connector' ) ),
			'schedule_saved'      => array( 'success', __( 'زمان‌بندی ذخیره شد.', 'pos-accounting-connector' ) ),
			'update_available'    => array( 'warning', __( 'نسخهٔ جدید افزونه آمادهٔ نصب است.', 'pos-accounting-connector' ) ),
			'up_to_date'          => array( 'success', __( 'افزونه به‌روز است.', 'pos-accounting-connector' ) ),
			'update_check_failed' => array( 'error', __( 'بررسی به‌روزرسانی ناموفق بود:', 'pos-accounting-connector' ) ),
		);
		return isset( $map[ $key ] ) ? $map[ $key ] : null;
	}

	/** The one-time detail a handler left for this user (see POS_Connector_Settings::flash_detail). */
	private static function take_notice_detail() {
		$key    = 'pos_connector_notice_detail_' . get_current_user_id();
		$detail = get_transient( $key );
		if ( false === $detail ) {
			return '';
		}
		delete_transient( $key );
		return (string) $detail;
	}

	private static function render_tabs( $current ) {
		echo '<nav class="pos-tabs" aria-label="' . esc_attr__( 'بخش‌های افزونه', 'pos-accounting-connector' ) . '">';
		foreach ( self::sections() as $key => $section ) {
			$url = admin_url( 'admin.php?page=' . $section['slug'] );
			echo '<a class="pos-tab ' . ( $current === $key ? 'is-active' : '' ) . '" href="' . esc_url( $url ) . '">' . esc_html( $section['label'] ) . '</a>';
		}
		echo '</nav>';
	}

	public static function render() {
		if ( ! current_user_can( pos_connector_admin_capability() ) ) {
			wp_die( esc_html__( 'دسترسی مجاز نیست.', 'pos-accounting-connector' ) );
		}
		$section  = self::current_section();
		$settings = pos_connector_settings();
		$counts   = POS_Connector_Queue::counts();
		$notice   = isset( $_GET['pos_notice'] ) ? self::notice_text( sanitize_key( wp_unslash( $_GET['pos_notice'] ) ) ) : null;
		?>
		<div class="wrap pos-admin" dir="rtl">
			<header class="pos-hero">
				<div>
					<p class="pos-eyebrow"><?php echo esc_html( pos_connector_brand() . ' — ' . __( 'اتصال فروشگاه', 'pos-accounting-connector' ) ); ?></p>
					<h1><?php esc_html_e( 'مدیریت WordPress و WooCommerce', 'pos-accounting-connector' ); ?></h1>
					<p><?php esc_html_e( 'اتصال، همگام‌سازی، صف‌ها، کرون و به‌روزرسانی افزونه در یک پیشخوان مستقل.', 'pos-accounting-connector' ); ?></p>
				</div>
				<div class="pos-hero__status">
					<?php echo ! empty( $settings['enabled'] ) ? self::status_badge( __( 'فعال محلی', 'pos-accounting-connector' ), 'good' ) : self::status_badge( __( 'غیرفعال محلی', 'pos-accounting-connector' ), 'warn' ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
					<?php echo pos_connector_woocommerce_active() ? self::status_badge( __( 'WooCommerce موجود', 'pos-accounting-connector' ), 'good' ) : self::status_badge( __( 'WooCommerce غیرفعال', 'pos-accounting-connector' ), 'bad' ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
				</div>
			</header>
			<?php self::render_tabs( $section ); ?>
			<?php if ( $notice ) : ?>
				<div class="notice notice-<?php echo esc_attr( $notice[0] ); ?>"><p><?php echo esc_html( $notice[1] . ( '' !== $detail ? ' ' . $detail : '' ) ); ?></p></div>
			<?php endif; ?>
			<?php if ( empty( $settings['base_url'] ) || empty( $settings['token'] ) ) : ?>
				<?php self::render_wizard( $settings ); ?>
			<?php elseif ( 'dashboard' === $section ) : ?>
				<?php self::render_dashboard( $settings, $counts ); ?>
			<?php elseif ( 'connection' === $section ) : ?>
				<?php self::render_connection( $settings ); ?>
			<?php elseif ( 'synchronization' === $section ) : ?>
				<?php self::render_synchronization( $settings ); ?>
			<?php elseif ( 'queue' === $section ) : ?>
				<?php self::render_queue( $counts ); ?>
			<?php elseif ( 'diagnostics' === $section ) : ?>
				<?php self::render_diagnostics( $settings ); ?>
			<?php elseif ( 'updates' === $section ) : ?>
				<?php self::render_updates(); ?>
			<?php endif; ?>
		</div>
		<?php
	}

	private static function render_wizard( $settings ) {
		?>
		<section class="pos-panel pos-wizard">
			<h2><?php esc_html_e( 'راه‌اندازی اولیه', 'pos-accounting-connector' ); ?></h2>
			<ol class="pos-steps">
				<li><?php esc_html_e( 'آدرس پنل بیزامیز را وارد کنید — آدرس فروشگاه ووکامرس نیست.', 'pos-accounting-connector' ); ?></li>
				<li><?php esc_html_e( 'توکن wplink_… را از صفحهٔ اتصال افزونه در پنل کپی کنید.', 'pos-accounting-connector' ); ?></li>
				<li><?php esc_html_e( 'ذخیره کنید، سپس «آزمایش اتصال» را بزنید.', 'pos-accounting-connector' ); ?></li>
				<li><?php esc_html_e( 'پس از تست موفق، همگام‌سازی اولیه شروع می‌شود.', 'pos-accounting-connector' ); ?></li>
			</ol>
			<?php self::render_connection_form( $settings, true ); ?>
		</section>
		<?php
	}

	private static function render_connection_form( $settings, $wizard = false ) {
		?>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="pos-form">
			<?php wp_nonce_field( 'pos_connector_save' ); ?>
			<input type="hidden" name="action" value="pos_connector_save" />
			<label>
				<span><?php esc_html_e( 'آدرس پنل بیزامیز (Platform URL)', 'pos-accounting-connector' ); ?></span>
				<input name="base_url" type="url" dir="ltr" class="regular-text" value="<?php echo esc_attr( $settings['base_url'] ); ?>" placeholder="https://app.example.com" />
			</label>
			<label>
				<span><?php esc_html_e( 'توکن اتصال wplink_…', 'pos-accounting-connector' ); ?></span>
				<input name="token" type="password" dir="ltr" class="regular-text" autocomplete="off" placeholder="<?php echo $settings['token'] ? esc_attr__( 'برای حفظ توکن فعلی خالی بگذارید', 'pos-accounting-connector' ) : 'wplink_…'; ?>" />
				<small><?php echo $settings['token'] ? esc_html__( 'توکن ذخیره شده و نمایش داده نمی‌شود.', 'pos-accounting-connector' ) : esc_html__( 'توکن فقط یک بار در پنل بیزامیز نمایش داده می‌شود.', 'pos-accounting-connector' ); ?></small>
			</label>
			<label class="pos-check">
				<input type="checkbox" name="enabled" value="1" <?php checked( ! empty( $settings['enabled'] ) ); ?> />
				<span><?php esc_html_e( 'فعال‌سازی محلی افزونه', 'pos-accounting-connector' ); ?></span>
			</label>
			<?php submit_button( $wizard ? __( 'ذخیره و ادامه', 'pos-accounting-connector' ) : __( 'ذخیره اتصال', 'pos-accounting-connector' ), 'primary', 'submit', false ); ?>
		</form>
		<?php if ( ! $wizard ) : ?>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="pos-inline-action">
				<?php wp_nonce_field( 'pos_connector_test' ); ?>
				<input type="hidden" name="action" value="pos_connector_test" />
				<?php submit_button( __( 'آزمایش اتصال از وردپرس', 'pos-accounting-connector' ), 'secondary', 'submit', false ); ?>
			</form>
		<?php endif; ?>
		<?php
	}

	private static function render_dashboard( $settings, $counts ) {
		$last_stats = is_array( $settings['last_run_stats'] ) ? $settings['last_run_stats'] : array();
		?>
		<div class="pos-grid pos-grid--cards">
			<?php self::card( __( 'اتصال', 'pos-accounting-connector' ), array(
				__( 'وضعیت', 'pos-accounting-connector' ) => ! empty( $settings['enabled'] ) ? __( 'فعال', 'pos-accounting-connector' ) : __( 'غیرفعال محلی', 'pos-accounting-connector' ),
				__( 'آدرس پنل', 'pos-accounting-connector' ) => $settings['base_url'],
				__( 'آخرین همگام‌سازی موفق', 'pos-accounting-connector' ) => self::format_time( $settings['last_sync_ok_at'] ),
				__( 'آخرین آزمایش اتصال', 'pos-accounting-connector' ) => self::format_time( $settings['last_ping_ok_at'] ),
				__( 'وضعیت سرور', 'pos-accounting-connector' ) => ! empty( $last_stats['paused'] ) ? __( 'متوقف از سمت پنل', 'pos-accounting-connector' ) : __( 'در حال کار', 'pos-accounting-connector' ),
			) ); ?>
			<?php self::card( __( 'افزونه و سرور', 'pos-accounting-connector' ), array(
				__( 'نسخه افزونه', 'pos-accounting-connector' ) => POS_CONNECTOR_VERSION,
				__( 'WordPress', 'pos-accounting-connector' ) => get_bloginfo( 'version' ),
				__( 'WooCommerce', 'pos-accounting-connector' ) => defined( 'WC_VERSION' ) ? WC_VERSION : __( 'غیرفعال', 'pos-accounting-connector' ),
				__( 'PHP', 'pos-accounting-connector' ) => PHP_VERSION,
			) ); ?>
			<?php self::card( __( 'صف محلی افزونه', 'pos-accounting-connector' ), array(
				__( 'در انتظار', 'pos-accounting-connector' ) => (int) $counts['pending'],
				__( 'در بک‌آف', 'pos-accounting-connector' ) => (int) POS_Connector_Queue::deferred_count(),
				__( 'ناموفق', 'pos-accounting-connector' ) => (int) $counts['failed'],
				__( 'ارسال‌شده', 'pos-accounting-connector' ) => (int) $counts['sent'],
			) ); ?>
			<?php self::card( __( 'کرون', 'pos-accounting-connector' ), array(
				__( 'روش اجرا', 'pos-accounting-connector' ) => defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ? __( 'کرون واقعی/سیستمی', 'pos-accounting-connector' ) : __( 'WP-Cron فقط هنگام بازدید', 'pos-accounting-connector' ),
				__( 'وضعیت کرون', 'pos-accounting-connector' ) => self::cron_state_label(),
				__( 'آخرین اجرای کرون', 'pos-accounting-connector' ) => self::format_time( $settings['last_run_at'] ),
				__( 'اجرای سریع بعدی', 'pos-accounting-connector' ) => self::next_cron_label( POS_CONNECTOR_CRON_HOOK ),
				__( 'بازخوانی سفارش بعدی', 'pos-accounting-connector' ) => self::next_cron_label( POS_CONNECTOR_CRON_RESYNC_ORDERS ),
				__( 'بازخوانی کاتالوگ بعدی', 'pos-accounting-connector' ) => self::next_cron_label( POS_CONNECTOR_CRON_RESYNC_PRODUCTS ),
			) ); ?>
		</div>
		<?php self::render_domain_cards( $settings ); ?>
		<?php self::render_running_jobs(); ?>
		<?php if ( ! empty( $settings['last_error'] ) ) : ?>
			<div class="notice notice-warning"><p><strong><?php esc_html_e( 'نیاز به توجه:', 'pos-accounting-connector' ); ?></strong> <?php echo esc_html( $settings['last_error'] ); ?></p></div>
		<?php endif; ?>
		<?php
	}

	private static function card( $title, $rows ) {
		echo '<section class="pos-card"><h2>' . esc_html( $title ) . '</h2><dl>';
		foreach ( $rows as $key => $value ) {
			echo '<div><dt>' . esc_html( $key ) . '</dt><dd>' . esc_html( (string) $value ) . '</dd></div>';
		}
		echo '</dl></section>';
	}

	private static function render_domain_cards( $settings ) {
		$domains = array(
			__( 'محصولات و طبقه‌بندی‌ها', 'pos-accounting-connector' ) => array( ! empty( $settings['sync_products'] ), $settings['last_products_sweep_at'], POS_CONNECTOR_CRON_RESYNC_PRODUCTS ),
			__( 'سفارش‌ها', 'pos-accounting-connector' ) => array( ! empty( $settings['sync_orders'] ), $settings['last_orders_sweep_at'], POS_CONNECTOR_CRON_RESYNC_ORDERS ),
			__( 'مشتریان', 'pos-accounting-connector' ) => array( ! empty( $settings['sync_customers'] ), $settings['last_customers_sweep_at'], POS_CONNECTOR_CRON_RESYNC_CUSTOMERS ),
			__( 'محتوا و رسانه', 'pos-accounting-connector' ) => array( true, $settings['last_content_sweep_at'], POS_CONNECTOR_CRON_RESYNC_CONTENT ),
		);
		echo '<section class="pos-panel"><h2>' . esc_html__( 'دامنه‌های همگام‌سازی', 'pos-accounting-connector' ) . '</h2><div class="pos-grid pos-grid--domains">';
		foreach ( $domains as $label => $data ) {
			echo '<article class="pos-domain"><h3>' . esc_html( $label ) . '</h3>';
			echo $data[0] ? self::status_badge( __( 'فعال', 'pos-accounting-connector' ), 'good' ) : self::status_badge( __( 'غیرفعال از پنل', 'pos-accounting-connector' ), 'warn' ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			echo '<p>' . esc_html__( 'آخرین بازخوانی کامل:', 'pos-accounting-connector' ) . ' ' . esc_html( self::format_time( $data[1] ) ) . '</p>';
			echo '<p>' . esc_html__( 'اجرای بعدی:', 'pos-accounting-connector' ) . ' ' . esc_html( self::next_cron_label( $data[2] ) ) . '</p>';
			echo '</article>';
		}
		echo '</div></section>';
	}

	/** «کرون اجرا می‌شود» / «کرون اجرا نمی‌شود» — from when the fast lane last started, never from a button press. */
	private static function cron_state_label() {
		$status = pos_connector_cron_status();
		if ( ! $status['configured'] ) {
			return __( 'اتصال فعال نیست', 'pos-accounting-connector' );
		}
		if ( $status['stale'] ) {
			/* translators: %s: how long ago the sync last started */
			return sprintf( __( 'اجرا نمی‌شود — آخرین اجرا %s پیش', 'pos-accounting-connector' ), human_time_diff( $status['reference_ts'], time() ) );
		}
		return __( 'در حال اجرا', 'pos-accounting-connector' );
	}

	/**
	 * The button presses waiting for cron, and the catalogue export that is
	 * still being read — so «در صف اجرا قرار گرفت» is something the screen can
	 * follow up on instead of a promise.
	 */
	private static function render_running_jobs() {
		$labels = array(
			'sync'      => __( 'اجرای سریع حمل‌ونقل', 'pos-accounting-connector' ),
			'products'  => __( 'بازخوانی کاتالوگ', 'pos-accounting-connector' ),
			'orders'    => __( 'بازخوانی سفارش‌ها', 'pos-accounting-connector' ),
			'customers' => __( 'بازخوانی مشتریان', 'pos-accounting-connector' ),
			'content'   => __( 'بازخوانی محتوا و رسانه', 'pos-accounting-connector' ),
		);
		$rows = array();
		foreach ( POS_Connector_Health::queued_manual_jobs( _get_cron_array(), POS_CONNECTOR_CRON_MANUAL_JOB ) as $kind ) {
			$rows[] = ( isset( $labels[ $kind ] ) ? $labels[ $kind ] : $kind ) . ' — ' . __( 'در انتظار اجرای کرون', 'pos-accounting-connector' );
		}
		foreach ( POS_Connector_Sync::pending_product_exports() as $state ) {
			$rows[] = sprintf(
				/* translators: 1: products read so far, 2: variations read so far */
				__( 'خواندن کاتالوگ در جریان است — %1$d محصول و %2$d تنوع تاکنون', 'pos-accounting-connector' ),
				(int) $state['parents'],
				(int) $state['variations']
			);
		}
		if ( empty( $rows ) ) {
			return;
		}
		echo '<section class="pos-panel"><h2>' . esc_html__( 'کارهای در جریان', 'pos-accounting-connector' ) . '</h2><ul>';
		foreach ( $rows as $row ) {
			echo '<li>' . esc_html( $row ) . '</li>';
		}
		echo '</ul></section>';
	}

	private static function next_cron_label( $hook ) {
		$at = wp_next_scheduled( $hook );
		return $at ? gmdate( 'Y-m-d H:i:s', $at ) . ' UTC' : __( 'زمان‌بندی نشده', 'pos-accounting-connector' );
	}

	private static function render_connection( $settings ) {
		echo '<section class="pos-panel"><h2>' . esc_html__( 'اتصال', 'pos-accounting-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'این صفحه فقط تنظیمات محلی حمل‌ونقل را نگه می‌دارد. کلیدهای همگام‌سازی سفارش/محصول/مشتری از پنل بیزامیز می‌آیند.', 'pos-accounting-connector' ) . '</p>';
		self::render_connection_form( $settings );
		echo '</section>';
	}

	private static function action_button( $action, $label, $class = 'secondary', $confirm = '' ) {
		?>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="pos-inline-action" <?php echo $confirm ? 'data-confirm="' . esc_attr( $confirm ) . '"' : ''; ?>>
			<?php wp_nonce_field( $action ); ?>
			<input type="hidden" name="action" value="<?php echo esc_attr( $action ); ?>" />
			<?php submit_button( $label, $class, 'submit', false ); ?>
		</form>
		<?php
	}

	private static function render_synchronization( $settings ) {
		?>
		<section class="pos-panel">
			<h2><?php esc_html_e( 'همگام‌سازی و زمان‌بندی', 'pos-accounting-connector' ); ?></h2>
			<div class="pos-actions">
				<?php self::action_button( 'pos_connector_sync_now', __( 'اجرای سریع حمل‌ونقل', 'pos-accounting-connector' ), 'primary' ); ?>
				<?php self::action_button( 'pos_connector_resync_products', __( 'بازخوانی کامل کاتالوگ', 'pos-accounting-connector' ) ); ?>
				<?php self::action_button( 'pos_connector_resync_orders', __( 'بازخوانی سفارش‌ها', 'pos-accounting-connector' ) ); ?>
				<?php self::action_button( 'pos_connector_resync_customers', __( 'بازخوانی مشتریان', 'pos-accounting-connector' ) ); ?>
				<?php self::action_button( 'pos_connector_resync_content', __( 'بازخوانی محتوا و رسانه', 'pos-accounting-connector' ) ); ?>
			</div>
			<?php self::render_domain_cards( $settings ); ?>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="pos-form pos-schedule-form">
				<?php wp_nonce_field( 'pos_connector_schedule' ); ?>
				<input type="hidden" name="action" value="pos_connector_schedule" />
				<label><span><?php esc_html_e( 'بازخوانی سفارش‌ها', 'pos-accounting-connector' ); ?></span><select name="resync_orders_schedule"><?php foreach ( pos_connector_order_resync_schedules() as $key => $label ) : ?><option value="<?php echo esc_attr( $key ); ?>" <?php selected( $settings['resync_orders_schedule'], $key ); ?>><?php echo esc_html( $label ); ?></option><?php endforeach; ?></select></label>
				<label><span><?php esc_html_e( 'بازه سفارش‌ها (روز)', 'pos-accounting-connector' ); ?></span><input name="resync_orders_days" type="number" min="1" max="365" value="<?php echo esc_attr( (int) $settings['resync_orders_days'] ); ?>" /></label>
				<label><span><?php esc_html_e( 'بازخوانی کاتالوگ', 'pos-accounting-connector' ); ?></span><select name="resync_products_schedule"><?php foreach ( pos_connector_resync_schedules() as $key => $label ) : ?><option value="<?php echo esc_attr( $key ); ?>" <?php selected( $settings['resync_products_schedule'], $key ); ?>><?php echo esc_html( $label ); ?></option><?php endforeach; ?></select></label>
				<?php submit_button( __( 'ذخیره زمان‌بندی', 'pos-accounting-connector' ), 'primary', 'submit', false ); ?>
			</form>
		</section>
		<?php
	}

	private static function render_queue( $counts ) {
		?>
		<section class="pos-panel">
			<h2><?php esc_html_e( 'صف محلی افزونه و خطاها', 'pos-accounting-connector' ); ?></h2>
			<p><?php esc_html_e( 'این صف داخل وردپرس است؛ با صف خروجی پنل بیزامیز یکی نیست. اگر وردپرس نتواند به پنل برسد، رویدادها اینجا باقی می‌مانند.', 'pos-accounting-connector' ); ?></p>
			<div class="pos-grid pos-grid--cards"><?php self::card( __( 'وضعیت صف', 'pos-accounting-connector' ), array( __( 'در انتظار', 'pos-accounting-connector' ) => (int) $counts['pending'], __( 'در بک‌آف', 'pos-accounting-connector' ) => POS_Connector_Queue::deferred_count(), __( 'ناموفق', 'pos-accounting-connector' ) => (int) $counts['failed'], __( 'ارسال‌شده', 'pos-accounting-connector' ) => (int) $counts['sent'] ) ); ?></div>
			<div class="pos-actions"><?php self::action_button( 'pos_connector_retry', __( 'تلاش دوباره برای ناموفق‌ها', 'pos-accounting-connector' ), 'secondary' ); ?></div>
		</section>
		<?php
	}

	private static function render_diagnostics( $settings ) {
		?>
		<section class="pos-panel">
			<h2><?php esc_html_e( 'عیب‌یابی', 'pos-accounting-connector' ); ?></h2>
			<?php if ( ! pos_connector_woocommerce_active() ) : ?><div class="notice notice-error inline"><p><?php esc_html_e( 'ووکامرس فعال نیست؛ همگام‌سازی فروشگاهی متوقف است اما اتصال و به‌روزرسانی افزونه قابل بررسی است.', 'pos-accounting-connector' ); ?></p></div><?php endif; ?>
			<details open><summary><?php esc_html_e( 'کرون واقعی', 'pos-accounting-connector' ); ?></summary>
				<p><?php esc_html_e( 'یک خط کافی است:', 'pos-accounting-connector' ); ?></p>
				<p><code dir="ltr"><?php echo esc_html( implode( "\n", pos_connector_system_cron_examples() ) ); ?></code></p>
				<p><?php esc_html_e( 'روی کانتینر یا هاستی که open_basedir اجرای wp را می‌بندد (برای کاربر root گزینهٔ --allow-root را هم اضافه کنید):', 'pos-accounting-connector' ); ?></p>
				<p><code dir="ltr"><?php echo esc_html( pos_connector_system_cron_open_basedir_example() ); ?></code></p>
				<p><?php esc_html_e( 'برای مانیتورینگ، دستور wp pos-connector status اگر کرون متوقف باشد با کد خروج غیرصفر تمام می‌شود.', 'pos-accounting-connector' ); ?></p>
			</details>
			<h3><?php esc_html_e( 'گزارش رویدادها', 'pos-accounting-connector' ); ?></h3>
			<table class="widefat striped"><thead><tr><th><?php esc_html_e( 'زمان UTC', 'pos-accounting-connector' ); ?></th><th><?php esc_html_e( 'رویداد', 'pos-accounting-connector' ); ?></th><th><?php esc_html_e( 'پیام', 'pos-accounting-connector' ); ?></th></tr></thead><tbody>
			<?php $entries = POS_Connector_Log::recent( 50 ); if ( empty( $entries ) ) : ?><tr><td colspan="3"><?php esc_html_e( 'گزارشی وجود ندارد.', 'pos-accounting-connector' ); ?></td></tr><?php endif; ?>
			<?php foreach ( $entries as $entry ) : ?><tr><td><?php echo esc_html( $entry['created_at'] ); ?></td><td><?php echo esc_html( $entry['action'] ); ?></td><td><?php echo esc_html( $entry['message'] ); ?></td></tr><?php endforeach; ?>
			</tbody></table>
		</section>
		<?php
	}

	private static function render_updates() {
		$update = POS_Connector_Updater::cached();
		?>
		<section class="pos-panel">
			<h2><?php esc_html_e( 'به‌روزرسانی افزونه', 'pos-accounting-connector' ); ?></h2>
			<?php if ( ! empty( $update['error'] ) && empty( $update['ok'] ) ) : ?>
				<div class="notice notice-info inline"><p><?php echo esc_html( POS_Connector_Updater::explain_error( $update['error'] ) ); ?> <code dir="ltr"><?php echo esc_html( $update['error'] ); ?></code></p></div>
			<?php endif; ?>
			<?php if ( ! empty( $update['ok'] ) && ! empty( $update['fallback_from'] ) ) : ?>
				<div class="notice notice-warning inline"><p><?php esc_html_e( 'سرور اصلی به‌روزرسانی در دسترس نبود؛ نتیجه از GitHub گرفته شد.', 'pos-accounting-connector' ); ?> <code dir="ltr"><?php echo esc_html( $update['fallback_from'] ); ?></code></p></div>
			<?php endif; ?>
			<?php self::card( __( 'نسخه و منبع', 'pos-accounting-connector' ), array( __( 'نسخه نصب‌شده', 'pos-accounting-connector' ) => POS_CONNECTOR_VERSION, __( 'آخرین نسخه', 'pos-accounting-connector' ) => $update['version'] ? $update['version'] : __( 'نامشخص', 'pos-accounting-connector' ), __( 'آخرین بررسی', 'pos-accounting-connector' ) => $update['checked_at'] ? gmdate( 'Y-m-d H:i:s', (int) $update['checked_at'] ) . ' UTC' : '—', __( 'منبع', 'pos-accounting-connector' ) => POS_Connector_Updater::update_url() ? POS_Connector_Updater::update_url() : __( 'GitHub اختیاری/توسعه', 'pos-accounting-connector' ) ) ); ?>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="pos-inline-action">
				<?php wp_nonce_field( 'pos_connector_check_update' ); ?><input type="hidden" name="action" value="pos_connector_check_update" /><?php submit_button( __( 'بررسی به‌روزرسانی', 'pos-accounting-connector' ), 'secondary', 'submit', false ); ?>
			</form>
		</section>
		<?php
	}
}
