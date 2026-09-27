<?php
/**
 * The self-update system — with two possible update servers.
 *
 * This plugin is not in the WordPress.org directory, so core will never
 * learn a new version exists: the directory's API is the only update source
 * WordPress ships with. What this class adds is the standard trio of hooks
 * a third-party update needs:
 *
 *   pre_set_site_transient_update_plugins   put a newer release into
 *                                           «افزونه‌ها ← به‌روزرسانی‌های موجود»
 *   plugins_api                             the «مشاهدهٔ جزئیات نسخهٔ …» modal
 *   upgrader_source_selection               make a third-party zip installable
 *
 * …pointed at whichever of the two sources is configured:
 *
 *   self-hosted (POS_CONNECTOR_UPDATE_URL)  a static update.json manifest on
 *                                           the owner's own server, next to
 *                                           the zip the «Build plugin zip»
 *                                           workflow produced. The intended
 *                                           mode for stores on networks where
 *                                           GitHub is slow, filtered or
 *                                           blocked — the check and the
 *                                           download both stay on that server.
 *   GitHub (the default while the URL is empty)
 *                                           this repository's releases —
 *                                           the release asset when one was
 *                                           attached, otherwise the tag's
 *                                           zipball of the whole repository,
 *                                           with the plugin buried at
 *                                           `wordpress-plugin/pos-accounting-connector/`
 *                                           (which is why the third hook
 *                                           exists: it re-points the source
 *                                           at that subfolder before
 *                                           WordPress copies it over the
 *                                           installed plugin).
 *
 * Whichever source answers, it flows into the same WordPress update UI, so
 * «افزونه‌ها ← به‌روزرسانی‌های موجود», one-click install, auto-update and
 * `wp plugin update pos-accounting-connector` all work unchanged.
 *
 * Checks are cached in an option (six hours for a good answer, fifteen
 * minutes for a failure) and ride the cycle WordPress already runs —
 * `wp_update_plugins()` twice daily from WP-Cron and on demand from the
 * Updates screen's «بررسی دوباره» — so no ordinary page view ever waits on
 * the update server. The settings screen and `wp pos-connector status`
 * print the cached answer only; the «بررسی به‌روزرسانی» button and
 * `wp pos-connector check-update` are the two things that force a call.
 *
 * The `package` URL is constrained before it is handed to WordPress,
 * because that is the URL WordPress will download and run: in GitHub mode
 * to this repository's own download hosts, and in self-hosted mode to the
 * manifest's own host (HTTPS, same host, nothing else).
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Updater {

	/** The cached check. An option, not a transient, so uninstall can remove it by name and the screen can show when it ran. */
	const CACHE_OPTION = 'pos_connector_update';

	/** How long a successful check stays fresh. Two a day matches the cycle WordPress already runs. */
	const CHECK_TTL = 6 * HOUR_IN_SECONDS;

	/** A failed check is retried sooner — the update server being unreachable for a moment must not cost six hours of silence. */
	const CHECK_FAILURE_TTL = 15 * MINUTE_IN_SECONDS;

	/** Repeated manifest/network failures log at most once per day. */
	const CHECK_FAILURE_LOG_INTERVAL = DAY_IN_SECONDS;

	/** The zip asset the release runbook attaches; extracting to the right folder, it needs no fix_source_dir() help. */
	const ASSET_NAME = 'pos-accounting-connector.zip';

	public static function init() {
		add_filter( 'pre_set_site_transient_update_plugins', array( __CLASS__, 'inject_update' ) );
		add_filter( 'plugins_api', array( __CLASS__, 'plugin_details' ), 10, 3 );
			add_filter( 'upgrader_pre_download', array( __CLASS__, 'verify_package_download' ), 10, 4 );
			add_filter( 'upgrader_source_selection', array( __CLASS__, 'fix_source_dir' ), 10, 4 );
		add_action( 'upgrader_process_complete', array( __CLASS__, 'after_update' ), 10, 2 );
		add_action( 'admin_post_pos_connector_check_update', array( __CLASS__, 'handle_check_update' ) );
	}

	/** `pos-accounting-connector/pos-accounting-connector.php` — the key WordPress indexes plugin updates by. */
	private static function plugin_basename() {
		return plugin_basename( POS_CONNECTOR_FILE );
	}

	/**
	 * The `owner/repo` to ask about. A constant everywhere except through this
	 * filter, which is how a private fork (needing its own token headers, see
	 * below) points the updater at itself without forking the class.
	 */
	private static function repo() {
		$repo = apply_filters( 'pos_connector_update_repo', POS_CONNECTOR_UPDATE_REPO );
		return is_string( $repo ) && preg_match( '/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/', $repo ) ? $repo : POS_CONNECTOR_UPDATE_REPO;
	}

	/**
	 * The self-hosted manifest URL, when the owner runs their own update
	 * server — the mode the «Build plugin zip» workflow feeds. Empty means
	 * GitHub mode. HTTPS only: this URL is fetched on a schedule forever, so
	 * a plaintext one would let anything on the path serve a plugin update.
	 */
	public static function update_url() {
		$url = apply_filters( 'pos_connector_update_url', POS_CONNECTOR_UPDATE_URL );
		if ( ! is_string( $url ) || '' === trim( $url ) ) {
			return '';
		}
		$url = esc_url_raw( trim( $url ) );
		return 'https' === wp_parse_url( $url, PHP_URL_SCHEME ) ? $url : '';
	}

	/**
	 * The newest known version, from the cache when fresh.
	 *
	 * `inject_update()` is the only caller that may reach the network — it
	 * runs inside WordPress's own update cycle (cron or the Updates screen),
	 * where a blocking call is what every third-party updater makes. The
	 * settings screen uses `cached()`, which never does.
	 */
	public static function latest( $force = false ) {
		$cached = self::read_cache();
		$ttl    = empty( $cached['ok'] ) ? self::CHECK_FAILURE_TTL : self::CHECK_TTL;
		if ( ! $force && ! empty( $cached['checked_at'] ) && ( time() - (int) $cached['checked_at'] ) < $ttl ) {
			return $cached;
		}
		return self::check();
	}

	/** The cached answer, whatever it is. Never touches the network: a page render must not wait on the update server. */
	public static function cached() {
		return self::read_cache();
	}

	private static function read_cache() {
		$defaults = array(
			// The last *successful* answers. Kept verbatim on a failed
			// refresh (see store()): a transient outage must not erase the
			// version an update nag was already built from.
			'version'      => '',
			'download_url' => '',
			'url'          => '',
			'changelog'    => '',
				'published_at' => '',
				'checksum'     => '',
				'checked_at'   => 0,
			'ok'           => false,
			'error'        => '',
			// 'self_host' or 'github' — which server the last successful
			// answer came from, so the screen can say so.
			'source'       => '',
		);
		$stored = get_option( self::CACHE_OPTION, array() );
		return wp_parse_args( is_array( $stored ) ? $stored : array(), $defaults );
	}

	/**
	 * Ask the configured source for the newest version, and cache the answer.
	 *
	 * One line of dispatch, on purpose: the two sources must stay
	 * interchangeable from here down — same cache, same comparison, same
	 * install path — so switching servers is a one-line change and never a
	 * behavioural one.
	 */
	public static function check() {
		$result = '' !== self::update_url() ? self::fetch_self_hosted() : self::fetch_github();
		return self::store( $result );
	}

	/**
	 * The self-hosted source: one static update.json manifest on the owner's
	 * own server, uploaded next to the zip by hand (both files come out of
	 * the «Build plugin zip» workflow).
	 *
	 * A manifest is unavoidable — WordPress cannot learn a version out of a
	 * zip without downloading the whole zip — so the workflow generates it
	 * and the runbook pins its shape:
	 *
	 *   { "version": "1.5.1", "download_url": "…/pos-accounting-connector.zip",
	 *     "notes": "…", "published_at": "…" }
	 *
	 * The download URL is accepted only over HTTPS and only on the
	 * manifest's own host: the manifest is served by a server this plugin
	 * trusts, and that trust must not turn into «this server may name any
	 * URL on the internet to install from».
	 */
	private static function fetch_self_hosted() {
		$manifest_url = self::update_url();
		$fields       = array(
			'version'      => '',
			'download_url' => '',
			'url'          => '',
			'changelog'    => '',
				'published_at' => '',
				'checksum'     => '',
				'error'        => '',
				'source'       => 'self_host',
		);

		$response = wp_remote_get(
			$manifest_url,
			array(
				'timeout' => 10,
				'headers' => array(
					'Accept'     => 'application/json',
					'User-Agent' => 'pos-accounting-connector/' . POS_CONNECTOR_VERSION,
				),
			)
		);

		$body = null;
		if ( is_wp_error( $response ) ) {
			$fields['error'] = 'manifest_unreachable';
		} else {
			$status = (int) wp_remote_retrieve_response_code( $response );
			if ( $status < 200 || $status >= 300 ) {
				$fields['error'] = 'manifest_http_' . $status;
			} else {
				$body = json_decode( wp_remote_retrieve_body( $response ), true );
				if ( ! is_array( $body ) ) {
					$fields['error'] = 'invalid_manifest';
				}
			}
		}

		if ( '' === $fields['error'] ) {
			$fields['version'] = self::normalize_version( isset( $body['version'] ) && is_string( $body['version'] ) ? $body['version'] : '' );
			$fields['download_url'] = isset( $body['download_url'] ) && is_string( $body['download_url'] ) ? $body['download_url'] : '';
				$checksum = isset( $body['checksum'] ) && is_string( $body['checksum'] ) ? strtolower( trim( $body['checksum'] ) ) : '';
				$checksum = preg_replace( '/^sha256:/', '', $checksum );
				if ( '' === $fields['version'] || '' === $fields['download_url'] || ! preg_match( '/^[a-f0-9]{64}$/', $checksum ) ) {
					$fields['error'] = 'invalid_manifest';
				} elseif ( ! self::url_on_manifest_host( $fields['download_url'], $manifest_url ) ) {
					$fields['error'] = 'unexpected_download_url';
				} else {
					$fields['changelog']    = isset( $body['notes'] ) && is_string( $body['notes'] ) ? $body['notes'] : '';
					$fields['published_at'] = isset( $body['published_at'] ) && is_string( $body['published_at'] ) ? $body['published_at'] : '';
					$fields['checksum']     = $checksum;
					$fields['url']          = isset( $body['url'] ) && is_string( $body['url'] ) ? $body['url'] : $manifest_url;
				}
		}

		return $fields;
	}

	/** HTTPS and the manifest's own host, or the manifest is refused. */
	private static function url_on_manifest_host( $candidate, $manifest_url ) {
		return is_string( wp_parse_url( (string) $candidate, PHP_URL_HOST ) )
			&& strtolower( (string) wp_parse_url( (string) $candidate, PHP_URL_HOST ) ) === strtolower( (string) wp_parse_url( (string) $manifest_url, PHP_URL_HOST ) )
			&& 'https' === wp_parse_url( (string) $candidate, PHP_URL_SCHEME )
			&& '' !== trim( (string) wp_parse_url( (string) $candidate, PHP_URL_PATH ) );
	}

	/**
	 * The GitHub source: the newest published release, else the newest tag.
	 */
	private static function fetch_github() {
		$fields = array(
			'version'      => '',
			'download_url' => '',
			'url'          => '',
			'changelog'    => '',
			'published_at' => '',
			'error'        => '',
			'source'       => 'github',
		);

		$release = self::api( '/repos/' . self::repo() . '/releases/latest' );

		if ( is_wp_error( $release ) && 'http_404' === $release->get_error_code() ) {
			// No published release at all — not an error, just the fallback
			// path: a plain tag is still a shippable version.
			$tags = self::api( '/repos/' . self::repo() . '/tags?per_page=1' );
			if ( is_wp_error( $tags ) ) {
				$fields['error'] = $tags->get_error_message();
			} elseif ( empty( $tags[0]['name'] ) ) {
				$fields['error'] = 'no_release_found';
			} else {
				$tag  = (string) $tags[0]['name'];
				$fields['version'] = self::normalize_version( $tag );
				$fields['error']   = '' === $fields['version'] ? 'unreadable_tag' : '';
				if ( '' !== $fields['version'] ) {
					$fields['download_url'] = self::zipball_url( $tag );
					$fields['url'] = 'https://github.com/' . self::repo() . '/releases/tag/' . rawurlencode( $tag );
				}
			}
		} elseif ( is_wp_error( $release ) ) {
			$fields['error'] = $release->get_error_message();
		} else {
			$tag  = isset( $release['tag_name'] ) ? (string) $release['tag_name'] : '';
			$fields['version'] = self::normalize_version( $tag );
			if ( '' === $fields['version'] ) {
				$fields['error'] = 'unreadable_tag';
			} else {
				$fields['download_url'] = self::release_package( $release, $tag );
				$fields['url']          = isset( $release['html_url'] ) ? (string) $release['html_url'] : '';
				$fields['changelog']    = isset( $release['body'] ) ? (string) $release['body'] : '';
				$fields['published_at'] = isset( $release['published_at'] ) ? (string) $release['published_at'] : '';
			}
		}

		// The one URL check that can kill an update: this is what WordPress
		// will download and run, so it is constrained before it becomes a
		// `package`, not trusted because the API said so.
		if ( '' !== $fields['download_url'] && ! self::valid_package_url( $fields['download_url'] ) ) {
			$fields['error']        = 'unexpected_package_url';
			$fields['download_url'] = '';
		}
		if ( '' === $fields['version'] && '' === $fields['error'] ) {
			$fields['error'] = 'no_release_found';
		}

		return $fields;
	}

	/**
	 * Cache one fetch result. A failure keeps the last good answer on the
	 * shelf (an update nag that was already showing survives a server being
	 * down for a quarter hour), marks the check as failed so it is retried
	 * on the short TTL, and leaves a line in «گزارش رویدادها» — «به‌روز نیست
	 * و نمی‌گویم چرا» is the diagnosable state this avoids.
	 */
	private static function store( array $result ) {
		$cached = self::read_cache();

		if ( '' !== $result['error'] ) {
			self::maybe_log_update_failure( $result['error'], $cached['error'] );
			$cached['checked_at'] = time();
			$cached['ok']         = false;
			$cached['error']      = $result['error'];
			update_option( self::CACHE_OPTION, $cached, false );
			return $cached;
		}

		$fresh = array(
			'version'      => $result['version'],
			'download_url' => $result['download_url'],
			'url'          => '' !== $result['url'] ? $result['url'] : ( 'self_host' === $result['source'] ? self::update_url() : 'https://github.com/' . self::repo() ),
			'changelog'    => $result['changelog'],
				'published_at' => $result['published_at'],
				'checksum'     => isset( $result['checksum'] ) ? $result['checksum'] : '',
				'checked_at'   => time(),
			'ok'           => true,
			'error'        => '',
			'source'       => $result['source'],
		);
		update_option( self::CACHE_OPTION, $fresh, false );
		delete_option( 'pos_connector_update_last_log' );
		return $fresh;
	}

	/**
	 * Log update-check failures without filling «گزارش رویدادها» on every retry.
	 *
	 * The Updates screen still reads the cached `error`; operators only need a
	 * log line when the failure is new or has been quiet for a day.
	 */
	private static function maybe_log_update_failure( $error, $previous_error ) {
		$error = (string) $error;
		if ( '' === $error ) {
			return;
		}
		$last = get_option( 'pos_connector_update_last_log', array() );
		if ( ! is_array( $last ) ) {
			$last = array();
		}
		$now      = time();
		$same     = isset( $last['error'] ) && $last['error'] === $error;
		$recent   = ! empty( $last['logged_at'] ) && ( $now - (int) $last['logged_at'] ) < self::CHECK_FAILURE_LOG_INTERVAL;
		$changed  = $previous_error !== $error;
		if ( $changed || ! $same || ! $recent ) {
			POS_Connector_Log::error( 'update', $error );
			update_option(
				'pos_connector_update_last_log',
				array(
					'error'     => $error,
					'logged_at' => $now,
				),
				false
			);
		}
	}

	/**
	 * One GitHub API GET. Unauthenticated — this repository is public and the
	 * check is cached, so a store makes two calls a day. The
	 * `pos_connector_updater_headers` filter is where a private fork adds its
	 * token headers without touching this class.
	 */
	private static function api( $path ) {
		$response = wp_remote_get(
			'https://api.github.com' . $path,
			array(
				'timeout' => 10,
				'headers' => apply_filters(
					'pos_connector_updater_headers',
					array(
						'Accept'     => 'application/vnd.github+json',
						// GitHub rejects requests without one; also tells
						// GitHub which version is asking.
						'User-Agent' => 'pos-accounting-connector/' . POS_CONNECTOR_VERSION,
					),
					$path
				),
			)
		);

		if ( is_wp_error( $response ) ) {
			return new WP_Error( 'request_failed', $response->get_error_message() );
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$body   = json_decode( wp_remote_retrieve_body( $response ), true );

		if ( 404 === $status ) {
			return new WP_Error( 'http_404', 'not_found' );
		}
		if ( $status < 200 || $status >= 300 || ! is_array( $body ) ) {
			return new WP_Error( 'http_' . $status, 'http_' . $status );
		}
		return $body;
	}

	/**
	 * `v1.4.0` → `1.4.0`. Anything that is not a plain version is refused,
	 * because this string becomes the `new_version` WordPress compares and
	 * the one a user reads before clicking update.
	 */
	private static function normalize_version( $tag ) {
		$tag = ltrim( trim( (string) $tag ), 'vV' );
		return preg_match( '/^\d+(\.\d+){0,3}(-[A-Za-z0-9.-]+)?$/', $tag ) ? $tag : '';
	}

	/**
	 * Pick the zip this update installs from: a release asset when one was
	 * attached (the runbook's output — small, right folder name), otherwise
	 * the zipball of the tag (the whole repository, which fix_source_dir()
	 * digs the plugin out of).
	 */
	private static function release_package( array $release, $tag ) {
		if ( ! empty( $release['assets'] ) && is_array( $release['assets'] ) ) {
			$any_zip = '';
			foreach ( $release['assets'] as $asset ) {
				if ( empty( $asset['name'] ) || empty( $asset['browser_download_url'] ) ) {
					continue;
				}
				if ( self::ASSET_NAME === $asset['name'] ) {
					return (string) $asset['browser_download_url'];
				}
				if ( '.zip' === strtolower( substr( (string) $asset['name'], -4 ) ) ) {
					$any_zip = (string) $asset['browser_download_url'];
				}
			}
			if ( '' !== $any_zip ) {
				return $any_zip;
			}
		}
		return self::zipball_url( $tag );
	}

	/** The whole-repository zip behind a tag — GitHub's own download host, no redirect hop. */
	private static function zipball_url( $tag ) {
		return 'https://codeload.github.com/' . self::repo() . '/zip/refs/tags/' . rawurlencode( $tag );
	}

	/**
	 * Constrain the `package` to this repository's own download hosts. The
	 * signed `objects.githubusercontent.com` paths release-asset redirects
	 * land on are opaque, so the host alone is trusted there; every other
	 * host must also carry the repository's own `owner/repo` in the path.
	 */
	private static function valid_package_url( $url ) {
		$host = wp_parse_url( (string) $url, PHP_URL_HOST );
		$path = (string) wp_parse_url( (string) $url, PHP_URL_PATH );

		if ( ! in_array( $host, array( 'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'api.github.com' ), true ) ) {
			return false;
		}
		if ( 'objects.githubusercontent.com' === $host ) {
			return '' !== $path;
		}
		return false !== strpos( '/' . $path . '/', '/' . self::repo() . '/' );
	}

	/** The one comparison every path shares: is the remote version newer than the installed one? */
	public static function is_newer( $version ) {
		return (bool) version_compare( (string) $version, POS_CONNECTOR_VERSION, '>' );
	}

	/**
	 * Persian, actionable text for the codes a failed check can leave
	 * behind — a missing manifest, an unreachable host and a wrong download
	 * URL all present as «به‌روز نیست» otherwise.
	 */
	public static function explain_error( $error ) {
		$map = array(
			'manifest_unreachable'    => 'به مانیفست به‌روزرسانی روی سرور شما دسترسی نشد. نشانی و در دسترس بودن سرور را بررسی کنید.',
			'invalid_manifest'        => 'محتوای مانیفست به‌روزرسانی معتبر نیست؛ فیلدهای version و download_url لازم‌اند.',
			'unexpected_download_url' => 'نشانی دانلود در مانیفست باید HTTPS و روی همان میزبانِ خود مانیفست باشد.',
			'no_release_found'        => 'نسخه‌ای برای به‌روزرسانی پیدا نشد.',
			'unreadable_tag'          => 'نام برچسب نسخه قابل خواندن نیست؛ الگوی v1.2.3 را رعایت کنید.',
			'unexpected_package_url'  => 'نشانی بستهٔ دانلود از منبع مورد اعتماد نبود و نادیده گرفته شد.',
		);
		return isset( $map[ $error ] ) ? $map[ $error ] : $error;
	}

	/**
	 * Put a newer version into WordPress's update list, whichever source it
	 * came from.
	 *
	 * Runs inside `wp_update_plugins()` — twice daily from WP-Cron, and on
	 * demand from the Updates screen's «بررسی دوباره» — which is exactly the
	 * cadence an update check should have. The first update-server call of a
	 * store's life happens inside this cycle, never on an ordinary page view.
	 */
	public static function inject_update( $transient ) {
		if ( ! is_object( $transient ) ) {
			return $transient;
		}

		$latest = self::latest();

		// Not `ok` — the last *successful* answer is kept verbatim by
		// store() through a failed refresh, and an update nag that was
		// already showing should survive the update server being down for a quarter
		// hour. Only a missing version, a missing (or rejected) package URL
		// or «not actually newer» turns into «checked, up to date».
		if ( empty( $latest['version'] ) || empty( $latest['download_url'] ) || ! self::is_newer( $latest['version'] ) ) {
			// «بررسی شد، به‌روز است» — recorded so the Plugins screen counts
			// this plugin as *checked* rather than unknown, the same way a
			// wordpress.org plugin is.
			$transient->no_update[ self::plugin_basename() ] = (object) array(
				'slug'        => 'pos-accounting-connector',
				'plugin'      => self::plugin_basename(),
				'new_version' => POS_CONNECTOR_VERSION,
				'url'         => 'https://github.com/' . self::repo(),
				'package'     => '',
			);
			return $transient;
		}

		$transient->response[ self::plugin_basename() ] = (object) array(
			'slug'          => 'pos-accounting-connector',
			'plugin'        => self::plugin_basename(),
			'new_version'   => $latest['version'],
			'url'           => $latest['url'],
			'package'       => $latest['download_url'],
			'requires'      => self::header( 'Requires at least' ),
			'requires_php'  => self::header( 'Requires PHP' ),
		);
		return $transient;
	}

	/**
	 * The «مشاهدهٔ جزئیات نسخهٔ …» modal. Without this the link would ask the
	 * WordPress.org API, which knows nothing about this plugin.
	 */
	public static function plugin_details( $result, $action, $args ) {
		if ( 'plugin_information' !== $action || empty( $args->slug ) || 'pos-accounting-connector' !== $args->slug ) {
			return $result;
		}

		$latest = self::latest();

		$sections = array(
			'description' => __( 'اتصال امن و دوطرفهٔ فروشگاه ووکامرس به سامانهٔ فروش و حسابداری: ارسال سفارش، برگشت وجه، محصول و مشتری؛ دریافت موجودی و قیمت.', 'pos-accounting-connector' ),
		);
		if ( '' !== $latest['changelog'] ) {
			// The notes arrive as plain text or light markdown (release body
			// or manifest `notes`); wpautop is the closest thing to rendering
			// that inside a WordPress modal, and wp_kses_post keeps the
			// notes from carrying anything they should not.
			$sections['changelog'] = wp_kses_post( wpautop( $latest['changelog'] ) );
		} else {
			$sections['changelog'] = '<p>' . esc_html__( 'یادداشت انتشار این نسخه در منبع به‌روزرسانی نوشته شده است.', 'pos-accounting-connector' ) . '</p>';
		}

		return (object) array(
			'name'          => 'POS Accounting Connector',
			'slug'          => 'pos-accounting-connector',
			'version'       => '' !== $latest['version'] ? $latest['version'] : POS_CONNECTOR_VERSION,
			'download_link' => $latest['download_url'],
			'author'        => '<a href="https://github.com/hamidnoshady">hamidnoshady</a>',
			'homepage'      => 'https://github.com/hamidnoshady/cafe-restaurant-pos',
			'requires'      => self::header( 'Requires at least' ),
			'requires_php'  => self::header( 'Requires PHP' ),
			'tested'        => '6.7',
			'sections'      => $sections,
			'last_updated'  => '' !== $latest['published_at'] ? gmdate( 'Y-m-d', strtotime( $latest['published_at'] ) ) : '',
		);
	}

	/** One header from the plugin file — the same values the update row advertises. */
	private static function header( $key ) {
		static $headers = null;
		if ( null === $headers ) {
			$headers = get_file_data(
				POS_CONNECTOR_FILE,
				array(
					'Requires at least' => 'Requires at least',
					'Requires PHP'      => 'Requires PHP',
				)
			);
		}
		return isset( $headers[ $key ] ) ? (string) $headers[ $key ] : '';
	}

		/**
		 * Download self-hosted packages with checksum verification before WordPress
		 * extracts them. GitHub/fork mode is left to WordPress's normal downloader
		 * and is intended only for development/forks.
		 */
		public static function verify_package_download( $reply, $package, $upgrader, $hook_extra ) {
			if ( false !== $reply || empty( $hook_extra['plugin'] ) || self::plugin_basename() !== $hook_extra['plugin'] ) {
				return $reply;
			}
			$latest = self::read_cache();
			if ( empty( $latest['checksum'] ) || empty( $latest['download_url'] ) || $package !== $latest['download_url'] ) {
				return $reply;
			}
			if ( ! function_exists( 'download_url' ) ) {
				require_once ABSPATH . 'wp-admin/includes/file.php';
			}
			$file = download_url( $package );
			if ( is_wp_error( $file ) ) {
				return $file;
			}
			$actual = hash_file( 'sha256', $file );
			if ( ! hash_equals( $latest['checksum'], $actual ) ) {
				@unlink( $file ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
				return new WP_Error( 'pos_connector_checksum_mismatch', __( 'بستهٔ به‌روزرسانی با چک‌سام اعلام‌شده هم‌خوانی ندارد.', 'pos-accounting-connector' ) );
			}
			return $file;
		}

		/**
		 * Make a GitHub zip installable — the third hook, and the one that makes
		 * the no-asset path work.
		 *
	 * A release asset built by package-release.sh extracts to
	 * `pos-accounting-connector/…` and needs nothing. The repository zipball
	 * extracts to the whole monorepo — Next.js app, docs, docker and all —
	 * with the plugin at `wordpress-plugin/pos-accounting-connector/`, so the
	 * source WordPress copies from has to be re-pointed at that subfolder;
	 * the rest of the tree is deleted by the upgrader's own working-directory
	 * cleanup afterwards.
	 *
	 * Only ever claims its own install: `hook_extra` carries the plugin
	 * basename on updates (core since 5.5), and an upload-install without
	 * one — «افزونه‌ها ← افزودن ← بارگذاری» — is claimed only if the zip
	 * actually looks like this plugin.
	 *
	 * Everything goes through `$wp_filesystem`, never `file_exists()` /
	 * `rename()`: on an ftpext/ssh2 host the extracted files are not on the
	 * web server's own disk, and the paths here are filesystem-API paths.
	 */
	public static function fix_source_dir( $source, $remote_source, $upgrader, $hook_extra = array() ) {
		global $wp_filesystem;
		if ( ! is_string( $source ) || '' === $source || ! $wp_filesystem ) {
			return $source;
		}
		$fs = $wp_filesystem;

		if ( ! empty( $hook_extra['plugin'] ) ) {
			// Somebody else's update — never touch it.
			if ( self::plugin_basename() !== $hook_extra['plugin'] ) {
				return $source;
			}
		} elseif ( ! self::source_looks_like_this_plugin( $source, $fs ) ) {
			// An upload-install with no plugin name in hook_extra: claim it
			// only if the zip looks like us.
			return $source;
		}

		$resolved = self::find_plugin_root( $source, $fs );
		if ( '' === $resolved ) {
			$unpacked = self::maybe_unpack_inner_zip( $source, $fs );
			if ( '' !== $unpacked ) {
				$resolved = self::find_plugin_root( $unpacked, $fs );
			}
		}
		if ( '' === $resolved ) {
			return $source;
		}

		// An update installs over the existing wp-content/plugins/pos-accounting-connector
		// whatever the source folder is called. A fresh upload-install copies the folder
		// name — keep it pos-accounting-connector for wp plugin update and docs.
		if ( empty( $hook_extra['plugin'] ) && 'pos-accounting-connector' !== basename( $resolved ) ) {
			$target = dirname( $resolved ) . '/pos-accounting-connector';
			if ( ! $fs->exists( $target ) && $fs->move( $resolved, $target ) ) {
				return $target;
			}
		}

		return $resolved;
	}

	/**
	 * Locate the directory that contains pos-accounting-connector.php inside an
	 * extracted package.
	 *
	 * WordPress calls upgrader_source_selection before it steps into a lone
	 * wrapper folder, so GitHub tag zipballs (repo-root/wordpress-plugin/…)
	 * and “zip inside a folder” uploads must be walked explicitly.
	 */
	private static function find_plugin_root( $source, $fs, $depth = 0 ) {
		$source = untrailingslashit( (string) $source );
		if ( '' === $source || $depth > 4 ) {
			return '';
		}

		$candidates = array(
			$source,
			$source . '/pos-accounting-connector',
			$source . '/wordpress-plugin/pos-accounting-connector',
		);
		foreach ( $candidates as $dir ) {
			if ( $fs->exists( $dir . '/pos-accounting-connector.php' ) ) {
				return $dir;
			}
		}

		$list = $fs->dirlist( $source, false, false );
		if ( ! is_array( $list ) || empty( $list ) ) {
			return '';
		}

		$dirs  = array();
		$files = array();
		foreach ( $list as $name => $meta ) {
			if ( ! is_array( $meta ) || empty( $meta['type'] ) ) {
				continue;
			}
			if ( 'd' === $meta['type'] ) {
				$dirs[] = $name;
			} elseif ( 'f' === $meta['type'] ) {
				$files[] = $name;
			}
		}

		// Typical GitHub zipball: one top-level directory, no loose files.
		if ( 1 === count( $dirs ) && empty( $files ) ) {
			return self::find_plugin_root( $source . '/' . $dirs[0], $fs, $depth + 1 );
		}

		return '';
	}

	/**
	 * Some hosts upload the workflow artifact without unpacking — a zip whose only
	 * entry is pos-accounting-connector.zip. Unpack it once so the upgrader sees
	 * the real plugin tree.
	 */
	private static function maybe_unpack_inner_zip( $source, $fs ) {
		$source = untrailingslashit( (string) $source );
		$list   = $fs->dirlist( $source, false, false );
		if ( ! is_array( $list ) ) {
			return '';
		}

		$files = array();
		foreach ( $list as $name => $meta ) {
			if ( is_array( $meta ) && 'f' === $meta['type'] ) {
				$files[] = $name;
			}
		}
		if ( 1 !== count( $files ) ) {
			return '';
		}

		$inner_name = $files[0];
		if ( self::ASSET_NAME !== $inner_name && '.zip' !== strtolower( substr( $inner_name, -4 ) ) ) {
			return '';
		}

		$inner_path = $source . '/' . $inner_name;
		if ( ! $fs->exists( $inner_path ) ) {
			return '';
		}

		if ( ! function_exists( 'unzip_file' ) ) {
			require_once ABSPATH . 'wp-admin/includes/file.php';
		}

		$dest = $source . '/pos-connector-package';
		if ( $fs->exists( $dest ) ) {
			$fs->delete( $dest, true );
		}

		$local = $inner_path;
		if ( 'direct' !== $fs->method ) {
			$local_copy = get_temp_dir() . wp_unique_filename( get_temp_dir(), $inner_name );
			if ( ! $fs->copy( $inner_path, $local_copy, true ) ) {
				return '';
			}
			$local = $local_copy;
		}

		$result = unzip_file( $local, $dest );
		if ( $local !== $inner_path && file_exists( $local ) ) {
			@unlink( $local ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		}
		if ( is_wp_error( $result ) || ! $fs->exists( $dest ) ) {
			return '';
		}

		return $dest;
	}

	/** Does this extracted zip contain this plugin, at either known layout? Used only for unnamed upload-installs. */
	private static function source_looks_like_this_plugin( $source, $fs ) {
		if ( '' !== self::find_plugin_root( $source, $fs ) ) {
			return true;
		}

		$source = untrailingslashit( (string) $source );
		$list   = $fs->dirlist( $source, false, false );
		if ( ! is_array( $list ) ) {
			return false;
		}
		$files = array();
		foreach ( $list as $name => $meta ) {
			if ( is_array( $meta ) && 'f' === $meta['type'] ) {
				$files[] = $name;
			}
		}

		return 1 === count( $files )
			&& ( self::ASSET_NAME === $files[0] || '.zip' === strtolower( substr( $files[0], -4 ) ) );
	}

	/**
	 * After a successful update: forget the cached check (it describes the
	 * version that was just replaced) and write the one log line that lets
	 * an owner tell an update apart in «گزارش رویدادها».
	 */
	public static function after_update( $upgrader, $options ) {
		if ( 'update' !== $options['action'] || 'plugin' !== $options['type'] ) {
			return;
		}
		$updated = array();
		if ( ! empty( $options['plugin'] ) ) {
			$updated[] = $options['plugin'];
		}
		if ( ! empty( $options['plugins'] ) ) {
			$updated = array_merge( $updated, (array) $options['plugins'] );
		}
		if ( ! in_array( self::plugin_basename(), $updated, true ) ) {
			return;
		}

		// The new files are on disk but this process still holds the old
		// constant, so the *cached* version — the one just installed — is
		// what the log line should say, read before the cache is dropped.
		$was = self::read_cache();
		delete_option( self::CACHE_OPTION );
		POS_Connector_Log::info( 'update', sprintf( 'افزونه به نسخهٔ %s به‌روز شد.', '' !== $was['version'] ? $was['version'] : 'جدید' ) );
	}

	/**
	 * «بررسی به‌روزرسانی» — the one user-initiated GitHub call, following the
	 * screen's own admin-post pattern.
	 */
	public static function handle_check_update() {
			if ( ! current_user_can( pos_connector_admin_capability() ) ) {
				wp_die( esc_html__( 'دسترسی مجاز نیست.', 'pos-accounting-connector' ) );
			}
		check_admin_referer( 'pos_connector_check_update' );

		$latest = self::check();

		$notice = 'update_check_failed';
		if ( empty( $latest['error'] ) && self::is_newer( $latest['version'] ) ) {
			$notice = 'update_available';
		} elseif ( empty( $latest['error'] ) ) {
			$notice = 'up_to_date';
		}

		// Back to the «به‌روزرسانی» tab the button lives on, not the dashboard —
		// the notice belongs next to the version card it is about.
		wp_safe_redirect(
			add_query_arg(
				array(
					'page'       => POS_Connector_Admin::MENU_SLUG . '-updates',
					'pos_notice' => rawurlencode( $notice ),
				),
				admin_url( 'admin.php' )
			)
		);
		exit;
	}
}
