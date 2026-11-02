<?php
/**
 * WP-CLI commands.
 *
 * The reason this file exists is one sentence from the app's own admin screen:
 * «کرون داخلی وردپرس فقط هنگام بازدید از سایت اجرا می‌شود». WP-Cron is a
 * best-effort scheduler driven by traffic; on a quiet store it does not run at
 * the interval it advertises, and on a store behind full-page caching it can
 * go hours without firing at all. Every deployment that cares runs a real
 * crontab that calls `wp cron event run --due-now` — or, with these commands,
 * drives the sync directly.
 *
 *   wp pos-connector status                      what is configured, what is queued, when each event runs
 *                                                (exits non-zero while the cron is stopped, for monitoring)
 *   wp pos-connector doctor [--json] [--ping]    read-only diagnosis of the whole pipeline: scheduler
 *                                                state and why, schedule/next due, lock age, backlog age,
 *                                                the last cycle's phase results (exits non-zero on failure)
 *   wp pos-connector sync                        the fast lane: handshake, push, pull
 *   wp pos-connector export products             queue the whole catalogue
 *   wp pos-connector export orders [--days=7]    queue recently-modified orders
 *   wp pos-connector export customers            queue every customer
 *   wp pos-connector export content              queue every post, page and media item
 *   wp pos-connector test                        ping the accounting system
 *   wp pos-connector check-update                ask GitHub for a newer plugin version
 *
 * Every write command is safe to call as often as a crontab likes: the queue
 * dedups on (topic, remote_id) while a row is pending, and the app dedups on
 * delivery id, so running this every minute costs one HTTP round trip rather
 * than a thousand duplicate sales.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_CLI {

	public static function init() {
		WP_CLI::add_command( 'pos-connector', __CLASS__ );
	}

	private static function require_configured() {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) ) {
			WP_CLI::error( 'همگام‌سازی غیرفعال است. ابتدا در منوی «بیزامیز» در پیشخوان وردپرس، بخش «اتصال»، آن را فعال کنید.' );
		}
		if ( empty( $settings['base_url'] ) || empty( $settings['token'] ) ) {
			WP_CLI::error( 'آدرس سامانه یا توکن وارد نشده است.' );
		}
		return $settings;
	}

	/**
	 * Show what is configured, what is queued, and when each cron event runs.
	 *
	 * ## EXAMPLES
	 *
	 *     wp pos-connector status
	 *
	 * @subcommand status
	 */
	public function status( $args, $assoc_args ) {
		$settings = pos_connector_settings();
		$counts   = POS_Connector_Queue::counts();

		WP_CLI::log( WP_CLI::colorize( '%B' . pos_connector_plugin_title() . '%n' ) );
		WP_CLI::log( '  ' . sprintf( 'نسخهٔ افزونه: %s', POS_CONNECTOR_VERSION ) );
		// The cached answer only — `status` prints what is known, it does not
		// wait on the update server. `check-update` is the command that asks.
		$update = POS_Connector_Updater::cached();
		WP_CLI::log(
			'  ' . sprintf(
				'منبع به‌روزرسانی: %s',
				POS_Connector_Updater::update_url()
					? POS_Connector_Updater::update_url()
					: 'GitHub (' . POS_CONNECTOR_UPDATE_REPO . ')'
			)
		);
		if ( '' !== $update['version'] ) {
			WP_CLI::log(
				'  ' . sprintf(
					'آخرین نسخهٔ منتشرشده: %s%s',
					$update['version'],
					POS_Connector_Updater::is_newer( $update['version'] ) ? ' — ' . __( 'به‌روزرسانی موجود است', 'pos-accounting-connector' ) : ''
				)
			);
		}
		WP_CLI::log( '  ' . sprintf( 'آدرس سامانه: %s', $settings['base_url'] ? $settings['base_url'] : '—' ) );
		WP_CLI::log( '  ' . sprintf( 'توکن: %s', $settings['token'] ? __( 'ثبت شده', 'pos-accounting-connector' ) : '—' ) );
		WP_CLI::log( '  ' . sprintf( 'وضعیت: %s', $settings['enabled'] ? __( 'فعال', 'pos-accounting-connector' ) : __( 'غیرفعال', 'pos-accounting-connector' ) ) );
		WP_CLI::log( '  ' . sprintf( 'آخرین اجرای کرون: %s', $settings['last_run_at'] ? $settings['last_run_at'] : '—' ) );
		WP_CLI::log( '  ' . sprintf( 'آخرین همگام‌سازی موفق: %s', $settings['last_sync_ok_at'] ? $settings['last_sync_ok_at'] : '—' ) );
		WP_CLI::log( '  ' . sprintf( 'آخرین آزمایش اتصال: %s', $settings['last_ping_ok_at'] ? $settings['last_ping_ok_at'] : '—' ) );
		if ( ! empty( $settings['last_error'] ) ) {
			WP_CLI::warning( sprintf( 'آخرین خطا: %s', $settings['last_error'] ) );
		}

		WP_CLI::log( '' );
		WP_CLI::log( WP_CLI::colorize( '%B' . __( 'صف ارسال', 'pos-accounting-connector' ) . '%n' ) );
		WP_CLI::log( '  ' . sprintf( 'در انتظار: %d • ارسال‌شده: %d • ناموفق: %d • در انتظارِ بازگشت: %d', $counts['pending'], $counts['sent'], $counts['failed'], POS_Connector_Queue::deferred_count() ) );

		WP_CLI::log( '' );
		WP_CLI::log( WP_CLI::colorize( '%B' . __( 'زمان‌بندی', 'pos-accounting-connector' ) . '%n' ) );
		foreach ( array(
			POS_CONNECTOR_CRON_HOOK             => __( 'همگام‌سازی سریع', 'pos-accounting-connector' ),
			POS_CONNECTOR_CRON_RESYNC_ORDERS    => __( 'بازخوانی سفارش‌ها', 'pos-accounting-connector' ),
			POS_CONNECTOR_CRON_RESYNC_PRODUCTS  => __( 'بازخوانی محصولات', 'pos-accounting-connector' ),
			POS_CONNECTOR_CRON_RESYNC_CUSTOMERS => __( 'بازخوانی مشتریان', 'pos-accounting-connector' ),
			POS_CONNECTOR_CRON_RESYNC_CONTENT   => __( 'بازخوانی محتوا', 'pos-accounting-connector' ),
		) as $hook => $label ) {
			$next = wp_next_scheduled( $hook );
			WP_CLI::log(
				'  ' . sprintf(
					'%s: %s (%s)',
					$label,
					$next ? gmdate( 'Y-m-d H:i:s', $next ) . ' UTC' : __( 'زمان‌بندی نشده', 'pos-accounting-connector' ),
					wp_get_schedule( $hook ) ? wp_get_schedule( $hook ) : '—'
				)
			);
		}

		WP_CLI::log( '' );
		$examples = pos_connector_system_cron_examples( ABSPATH );
		if ( pos_connector_uses_system_cron() ) {
			WP_CLI::log(
				WP_CLI::colorize(
					'%G' . __( 'کرون سیستمی (DISABLE_WP_CRON=true) — این یک خط را در crontab سرور قرار دهید:', 'pos-accounting-connector' ) . '%n'
				)
			);
		} else {
			WP_CLI::warning(
				__( 'WP-Cron فعال است و فقط هنگام بازدید از سایت اجرا می‌شود — برای همگام‌سازی دقیق، DISABLE_WP_CRON را در wp-config.php true کنید و کرون سیستمی بگذارید:', 'pos-accounting-connector' )
			);
		}
		foreach ( $examples as $line ) {
			WP_CLI::log( '  ' . $line );
		}
		WP_CLI::log(
			'  # ' . __( 'یک خط کافی است؛ همهٔ رویدادهای سررسید (همگام‌سازی سریع، بازخوانی سفارش، کاتالوگ، مشتری، محتوا) را اجرا می‌کند.', 'pos-accounting-connector' )
		);
		WP_CLI::log(
			'  # ' . __( 'اگر open_basedir اجرای wp را می‌بندد:', 'pos-accounting-connector' ) . ' ' . pos_connector_system_cron_open_basedir_example( ABSPATH )
		);

		// Monitoring: a crontab line that cannot execute its command still
		// "succeeds" to the scheduler, so the exit code is the alert.
		$cron = pos_connector_cron_status();
		if ( $cron['stale'] ) {
			WP_CLI::error(
				sprintf( 'کرون اجرا نمی‌شود: آخرین اجرا %d ثانیه پیش بود (آستانه %d ثانیه).', $cron['age'], POS_Connector_Health::stale_after_seconds() )
			);
		}
	}

	/**
	 * Diagnose the scheduler and the sync pipeline, without changing anything.
	 *
	 * Issue #1206: «کرون زمان‌بندی شده است», «آزمایش اتصال موفق بود» and «صف
	 * خالی است» are each compatible with a connector that has applied nothing
	 * for days. This command prints the evidence for all of them at once —
	 * the scheduler's current state and why, whether each schedule exists and
	 * when it is due, how long the run lock has been held, the age of the
	 * oldest unsent row, and the phase results of the last cycle — and exits
	 * non-zero only when the pipeline is currently failing.
	 *
	 * It never writes settings, never moves a success timestamp and never
	 * changes store data. `--ping` also asks the app whether it can be
	 * reached; a plain run makes no outbound request, so it is safe to call
	 * from a monitoring loop at any interval.
	 *
	 * ## OPTIONS
	 *
	 * [--json]
	 * : Machine-readable output for monitoring and support tickets.
	 *
	 * [--ping]
	 * : Also ping the panel. A successful ping is a CONNECTION test only; it
	 * proves the address and the token, never that the scheduler runs.
	 *
	 * ## EXAMPLES
	 *
	 *     wp pos-connector doctor
	 *     wp pos-connector doctor --json
	 *
	 * @subcommand doctor
	 */
	public function doctor( $args, $assoc_args ) {
		$settings = pos_connector_settings();
		$now      = time();
		$state    = POS_Connector_Health::cron_state( $settings, $now );
		$counts   = POS_Connector_Queue::counts();
		$lock     = POS_Connector_Lock::peek( 'run', new POS_Connector_Option_Lock_Store(), $now );
		$oldest   = POS_Connector_Queue::oldest_pending_at();
		$oldest_ts = POS_Connector_Health::parse_utc( $oldest );

		$report = array(
			'pluginVersion' => POS_CONNECTOR_VERSION,
			'checkedAt'     => gmdate( 'c' ),
			'configured'    => $state['configured'],
			'enabled'       => ! empty( $settings['enabled'] ),
			'baseUrl'       => $settings['base_url'],
			'tokenSet'      => '' !== $settings['token'],
			'cronMode'      => pos_connector_uses_system_cron() ? 'system' : 'wp_cron',
			'cron'          => array(
				'state'              => $state['state'],
				'reason'             => $state['reason'],
				'lastStartedAt'      => $settings['last_run_at'],
				'lastCompletedAt'    => $settings['last_run_completed_at'],
				'lastVerifiedCycleAt' => $settings['last_sync_ok_at'],
				'lastDataAppliedAt'  => $settings['last_data_applied_at'],
				'lastPingOkAt'       => $settings['last_ping_ok_at'],
				'gapSeconds'         => $state['age'],
				'missedIntervals'    => $state['missedIntervals'],
				'delayedAfterSeconds'  => POS_Connector_Health::delayed_after_seconds(),
				'criticalAfterSeconds' => POS_Connector_Health::CRITICAL_AFTER_SECONDS,
			),
			'schedules'     => array(),
			'lock'          => $lock,
			'queue'         => array(
				'pending'  => (int) $counts['pending'],
				'deferred' => (int) POS_Connector_Queue::deferred_count(),
				'failed'   => (int) $counts['failed'],
				'sent'     => (int) $counts['sent'],
				'oldestPendingAt'      => $oldest,
				'oldestPendingSeconds' => $oldest_ts > 0 ? max( 0, $now - $oldest_ts ) : null,
			),
			'lastCycle'     => array(
				'verdict' => $settings['last_cycle_verdict'],
				'phases'  => array_values( (array) $settings['last_cycle_phases'] ),
				'error'   => $settings['last_error'],
			),
			'incident'      => array(
				'open'        => ! empty( $settings['incident_open'] ),
				'at'          => $settings['incident_at'],
				'gapSeconds'  => (int) $settings['incident_gap_seconds'],
				'recoveredAt' => $settings['incident_recovered_at'],
			),
		);
		foreach ( array(
			POS_CONNECTOR_CRON_HOOK,
			POS_CONNECTOR_CRON_RESYNC_ORDERS,
			POS_CONNECTOR_CRON_RESYNC_PRODUCTS,
			POS_CONNECTOR_CRON_RESYNC_CUSTOMERS,
			POS_CONNECTOR_CRON_RESYNC_CONTENT,
		) as $hook ) {
			$next = wp_next_scheduled( $hook );
			$report['schedules'][ $hook ] = array(
				'next'     => $next ? gmdate( 'c', (int) $next ) : null,
				'schedule' => wp_get_schedule( $hook ) ? wp_get_schedule( $hook ) : null,
			);
		}

		if ( isset( $assoc_args['ping'] ) ) {
			$client = POS_Connector_Client::from_settings();
			$report['ping'] = $client
				? POS_Connector_Health::interpret_ping(
					$client->post( '/api/integrations/wordpress/ping', array( 'siteUrl' => home_url(), 'pluginVersion' => POS_CONNECTOR_VERSION ) ),
					$now
				)
				: array( 'notice' => 'not_configured', 'detail' => '', 'skew' => null );
			// Said out loud, because this is the exact confusion #1206 is about.
			$report['ping']['note'] = 'connection_test_only: proves the address and token, not the scheduler';
		}

		// A current failure is the exit code; a warning is not. `delayed` is
		// still running, just late, and a monitoring loop that pages on it
		// would page on every shared-host hiccup.
		$failing = 'failed' === $state['state'];

		if ( isset( $assoc_args['json'] ) ) {
			WP_CLI::line( wp_json_encode( $report ) );
			if ( $failing ) {
				WP_CLI::halt( 1 );
			}
			return;
		}

		WP_CLI::log( WP_CLI::colorize( '%B' . __( 'وضعیت زمان‌بند', 'pos-accounting-connector' ) . '%n' ) );
		WP_CLI::log( '  ' . sprintf( 'حالت: %s (%s)', $state['state'], $state['reason'] ) );
		WP_CLI::log( '  ' . sprintf( 'آخرین شروع: %s • آخرین پایان: %s', $report['cron']['lastStartedAt'] ? $report['cron']['lastStartedAt'] : '—', $report['cron']['lastCompletedAt'] ? $report['cron']['lastCompletedAt'] : '—' ) );
		WP_CLI::log( '  ' . sprintf( 'آخرین دورهٔ تأییدشده: %s • آخرین دادهٔ اعمال‌شده: %s', $report['cron']['lastVerifiedCycleAt'] ? $report['cron']['lastVerifiedCycleAt'] : '—', $report['cron']['lastDataAppliedAt'] ? $report['cron']['lastDataAppliedAt'] : '—' ) );
		WP_CLI::log( '  ' . sprintf( 'فاصله از آخرین شروع: %d ثانیه (هشدار پس از %d، خطا پس از %d)', $report['cron']['gapSeconds'], $report['cron']['delayedAfterSeconds'], $report['cron']['criticalAfterSeconds'] ) );

		WP_CLI::log( '' );
		WP_CLI::log( WP_CLI::colorize( '%B' . __( 'زمان‌بندی', 'pos-accounting-connector' ) . '%n' ) );
		foreach ( $report['schedules'] as $hook => $entry ) {
			WP_CLI::log( '  ' . sprintf( '%s: %s (%s)', $hook, $entry['next'] ? $entry['next'] : __( 'زمان‌بندی نشده', 'pos-accounting-connector' ), $entry['schedule'] ? $entry['schedule'] : '—' ) );
		}

		WP_CLI::log( '' );
		WP_CLI::log( WP_CLI::colorize( '%B' . __( 'قفل اجرا', 'pos-accounting-connector' ) . '%n' ) );
		WP_CLI::log(
			'  ' . ( $lock['held']
				? sprintf( 'گرفته‌شده؛ %d ثانیه تا انقضا%s', (int) $lock['seconds_left'], $lock['expired'] ? ' — منقضی: اجرای قبلی نیمه‌کاره ماند' : '' )
				: __( 'آزاد', 'pos-accounting-connector' ) )
		);

		WP_CLI::log( '' );
		WP_CLI::log( WP_CLI::colorize( '%B' . __( 'صف محلی (وردپرس ← بیزامیز)', 'pos-accounting-connector' ) . '%n' ) );
		WP_CLI::log( '  ' . sprintf( 'در انتظار: %d • بک‌آف: %d • ناموفق: %d • ارسال‌شده: %d', $report['queue']['pending'], $report['queue']['deferred'], $report['queue']['failed'], $report['queue']['sent'] ) );
		if ( null !== $report['queue']['oldestPendingSeconds'] ) {
			WP_CLI::log( '  ' . sprintf( 'قدیمی‌ترین ردیف منتظر: %d ثانیه (%s)', $report['queue']['oldestPendingSeconds'], $oldest ) );
		}

		WP_CLI::log( '' );
		WP_CLI::log( WP_CLI::colorize( '%B' . __( 'آخرین دوره', 'pos-accounting-connector' ) . '%n' ) );
		WP_CLI::log( '  ' . sprintf( 'نتیجه: %s', '' !== $report['lastCycle']['verdict'] ? $report['lastCycle']['verdict'] : '—' ) );
		foreach ( $report['lastCycle']['phases'] as $phase ) {
			if ( ! is_array( $phase ) ) {
				continue;
			}
			WP_CLI::log(
				'  ' . sprintf(
					'- %s: %s%s%s',
					isset( $phase['phase'] ) ? $phase['phase'] : '?',
					isset( $phase['status'] ) ? $phase['status'] : '?',
					! empty( $phase['counts'] ) ? ' ' . wp_json_encode( $phase['counts'] ) : '',
					! empty( $phase['error'] ) ? ' — ' . $phase['error'] : ''
				)
			);
		}
		if ( '' !== $report['lastCycle']['error'] ) {
			WP_CLI::log( '  ' . sprintf( 'خطا: %s', $report['lastCycle']['error'] ) );
		}

		WP_CLI::log( '' );
		WP_CLI::log( WP_CLI::colorize( '%B' . __( 'آخرین وقفه', 'pos-accounting-connector' ) . '%n' ) );
		WP_CLI::log(
			'  ' . ( '' === $report['incident']['at']
				? __( 'ثبت نشده', 'pos-accounting-connector' )
				: sprintf(
					'شروع %s • %d ثانیه • %s',
					$report['incident']['at'],
					$report['incident']['gapSeconds'],
					$report['incident']['open']
						? __( 'هنوز باز', 'pos-accounting-connector' )
						: sprintf( 'رفع شد در %s', '' !== $report['incident']['recoveredAt'] ? $report['incident']['recoveredAt'] : '—' )
				) )
		);

		if ( isset( $report['ping'] ) && is_array( $report['ping'] ) ) {
			WP_CLI::log( '' );
			WP_CLI::log( WP_CLI::colorize( '%B' . __( 'آزمایش اتصال (فقط اتصال، نه کرون)', 'pos-accounting-connector' ) . '%n' ) );
			WP_CLI::log( '  ' . $report['ping']['notice'] . ( '' !== $report['ping']['detail'] ? ' ' . $report['ping']['detail'] : '' ) );
		}

		if ( $failing ) {
			WP_CLI::error(
				sprintf(
					/* translators: 1: state reason, 2: seconds since the last start */
					__( 'همگام‌سازی در حال اجرا نیست: %1$s (آخرین شروع %2$d ثانیه پیش).', 'pos-accounting-connector' ),
					$state['reason'],
					$state['age']
				)
			);
		}
		if ( 'delayed' === $state['state'] ) {
			WP_CLI::warning( sprintf( 'زمان‌بند دیرکرده است: آخرین شروع %d ثانیه پیش (هشدار از %d ثانیه).', $state['age'], POS_Connector_Health::delayed_after_seconds() ) );
		}
		if ( 'test_only' === $state['state'] ) {
			WP_CLI::warning( __( 'فقط آزمایش اتصال دیده شده است؛ کرون هرگز اجرا نشده.', 'pos-accounting-connector' ) );
		}
		if ( '' === $settings['last_cycle_verdict'] ) {
			WP_CLI::log( __( 'هنوز هیچ دوره‌ای ثبت نشده است؛ عدد «هیچ» به معنی «موفق» نیست.', 'pos-accounting-connector' ) );
		}
	}

	/**
	 * Run the fast lane: handshake, push queued events, lease and apply jobs.
	 *
	 * ## EXAMPLES
	 *
	 *     wp pos-connector sync
	 *
	 * @subcommand sync
	 */
	public function sync( $args, $assoc_args ) {
		self::require_configured();
		$stats = POS_Connector_Sync::run();
		if ( ! $stats ) {
			WP_CLI::error( 'اجرا ناموفق بود؛ گزارش رویدادها را ببینید.' );
		}
		if ( ! empty( $stats['locked'] ) ) {
			WP_CLI::warning( 'اجرای دیگری در جریان است؛ این اجرا انجام نشد.' );
			return;
		}
		$verdict = isset( $stats['verdict'] ) ? (string) $stats['verdict'] : '';
		// #1206 P0: a cycle whose phases failed is not a success, and the exit
		// code is what a monitoring crontab reads.
		if ( '' !== $verdict && ! in_array( $verdict, array( POS_Connector_Health::PHASE_OK, POS_Connector_Health::PHASE_EMPTY, POS_Connector_Health::PHASE_SKIPPED ), true ) ) {
			WP_CLI::error(
				sprintf(
					'دورهٔ همگام‌سازی کامل نشد (%s) — ارسال: %d • اعمال: %d. جزئیات: wp pos-connector doctor',
					$verdict,
					(int) $stats['pushed'],
					(int) $stats['applied']
				)
			);
		}
		WP_CLI::success(
			sprintf( 'ارسال: %d • اعمال: %d', (int) $stats['pushed'], (int) $stats['applied'] )
		);
	}

	/**
	 * Test the connection.
	 *
	 * ## EXAMPLES
	 *
	 *     wp pos-connector test
	 *
	 * @subcommand test
	 */
	public function test( $args, $assoc_args ) {
		self::require_configured();
		$client   = POS_Connector_Client::from_settings();
		$response = $client->post(
			'/api/integrations/wordpress/ping',
			array(
				'siteUrl'       => home_url(),
				'pluginVersion' => POS_CONNECTOR_VERSION,
			)
		);
		$result = POS_Connector_Health::interpret_ping( $response, time() );
		if ( $response['ok'] && 'test_ok' !== $result['notice'] ) {
			// Reachable, but not healthy: say why, and exit non-zero so a
			// monitored crontab does not report a paused connection as fine.
			WP_CLI::error( 'test_paused' === $result['notice'] ? 'اتصال در پنل بیزامیز متوقف شده است.' : sprintf( 'اختلاف ساعت با سامانه: %s ثانیه.', $result['detail'] ) );
		}
		if ( $response['ok'] ) {
			// `WP_CLI::success()` prints and returns — it does not exit. Without
			// this return the error below ran on a *successful* ping too, with
			// an empty message, and the command exited 1: a monitored crontab
			// reported a healthy connection as broken.
			WP_CLI::success( __( 'اتصال برقرار است.', 'pos-accounting-connector' ) );
			return;
		}
		$message = POS_Connector_Client::explain( $response['error'] );
		if ( 'test_site_mismatch' === $result['notice'] && '' !== $result['detail'] ) {
			$message .= ' ' . $result['detail'];
		}
		WP_CLI::error( $message );
	}

	/**
	 * Ask GitHub for a newer version of this plugin.
	 *
	 * This is the same call the «بررسی به‌روزرسانی» button makes, and the one
	 * WordPress's own twice-daily cycle makes for itself. Installing the
	 * version it finds is left to WordPress — the Plugins screen, the
	 * Updates screen, or `wp plugin update pos-accounting-connector`.
	 *
	 * ## EXAMPLES
	 *
	 *     wp pos-connector check-update
	 *
	 * @subcommand check-update
	 */
	public function check_update( $args, $assoc_args ) {
		$latest = POS_Connector_Updater::check();

		WP_CLI::log( '  ' . sprintf( 'نسخهٔ نصب‌شده: %s', POS_CONNECTOR_VERSION ) );
		WP_CLI::log( '  ' . sprintf( 'آخرین نسخهٔ منتشرشده: %s', '' !== $latest['version'] ? $latest['version'] : '—' ) );

		if ( '' !== $latest['error'] ) {
			WP_CLI::error( sprintf( 'بررسی به‌روزرسانی ناموفق بود: %s', POS_Connector_Updater::explain_error( $latest['error'] ) ) );
		}

		if ( POS_Connector_Updater::is_newer( $latest['version'] ) ) {
			WP_CLI::warning(
				sprintf(
					'نسخهٔ جدید %s موجود است؛ از صفحهٔ «افزونه‌ها» نصبش کنید یا: wp plugin update pos-accounting-connector',
					$latest['version']
				)
			);
			return;
		}

		WP_CLI::success( __( 'افزونه به‌روز است.', 'pos-accounting-connector' ) );
	}

	/**
	 * Queue a full export.
	 *
	 * ## OPTIONS
	 *
	 * <kind>
	 * : What to export — products, orders, customers or content.
	 *
	 * [--days=<days>]
	 * : For `orders`, how far back to look. Default 7.
	 *
	 * ## EXAMPLES
	 *
	 *     wp pos-connector export products
	 *     wp pos-connector export orders --days=30
	 *
	 * @subcommand export
	 */
	public function export( $args, $assoc_args ) {
		self::require_configured();
		$kind = isset( $args[0] ) ? strtolower( (string) $args[0] ) : '';

		switch ( $kind ) {
			case 'products':
				// The catalogue is read in time-boxed slices; a command-line run has
				// no web timeout, so it simply keeps going until the last slice.
				POS_Connector_Sync::export_products();
				$guard = 0;
				while ( ( $running = array_keys( POS_Connector_Sync::pending_product_exports() ) ) && ++$guard < 500 ) {
					POS_Connector_Sync::export_products( $running[0] );
				}
				WP_CLI::success( __( 'محصولات در صف قرار گرفتند.', 'pos-accounting-connector' ) );
				return;
			case 'orders':
				$days = isset( $assoc_args['days'] ) ? (int) $assoc_args['days'] : (int) pos_connector_settings()['resync_orders_days'];
				$count = POS_Connector_Sync::export_orders( $days );
				WP_CLI::success( sprintf( '%d سفارش در صف قرار گرفت.', $count ) );
				return;
			case 'customers':
				POS_Connector_Sync::export_customers();
				WP_CLI::success( __( 'مشتریان در صف قرار گرفتند.', 'pos-accounting-connector' ) );
				return;
			case 'content':
				// The fourth export the plugin has answered as a job since
				// 1.2.0. Every other one is drivable from here, and a WP-Cron
				// that never fires is exactly when that matters.
				POS_Connector_Sync::export_content();
				WP_CLI::success( __( 'محتوا و رسانه در صف قرار گرفتند.', 'pos-accounting-connector' ) );
				return;
			default:
				WP_CLI::error( 'نوع را مشخص کنید: products | orders | customers | content' );
		}
	}
}
