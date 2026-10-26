<?php
/**
 * The signed HTTP client — WordPress's mirror of the app's
 * src/lib/integrations/plugin-link.ts.
 *
 * The two files must agree byte-for-byte on one string, so it is written the
 * same way in both:
 *
 *     v1:{timestamp}:{nonce}:{sha256hex(body)}
 *
 * signed with HMAC-SHA256, keyed by the link token. Get that wrong in either
 * direction and every request is a 401 with nothing to see in a log, so the
 * definition is quoted here rather than assumed.
 *
 * Three things beyond the bearer token, and each earns its place:
 *   - the **timestamp** bounds how long a captured request stays usable;
 *   - the **nonce** stops it being usable even twice inside that window;
 *   - the **body HMAC** means a proxy that can read the request cannot alter
 *     an order total on its way through.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Client {

	/** Matches the app's PLUGIN_TIMESTAMP_SKEW_MS. */
	const TIMESTAMP_SKEW_MS = 300000;

	/** @var string */
	private $base_url;

	/** @var string */
	private $token;

	public function __construct( $base_url, $token ) {
		$this->base_url = untrailingslashit( trim( (string) $base_url ) );
		$this->token    = trim( (string) $token );
	}

	/** Built from the current settings; null when the plugin has not been configured yet. */
	public static function from_settings() {
		$settings = pos_connector_settings();
		if ( empty( $settings['base_url'] ) || empty( $settings['token'] ) ) {
			return null;
		}
		return new self( $settings['base_url'], $settings['token'] );
	}

	/**
	 * The exact string both sides sign.
	 *
	 * The body is hashed rather than concatenated so this stays a fixed length
	 * whatever the payload size, and the separator is a character that cannot
	 * occur in a timestamp, a nonce (charset-restricted below) or a hex digest.
	 */
	public static function signing_string( $timestamp, $nonce, $body ) {
		return 'v1:' . $timestamp . ':' . $nonce . ':' . hash( 'sha256', $body );
	}

	/**
	 * URL-safe base64 of 16 random bytes — inside the app's `[A-Za-z0-9_-]{8,128}`
	 * nonce charset, and unpredictable, which matters because a guessable nonce
	 * would let an attacker burn the value a legitimate request is about to use.
	 */
	private function nonce() {
		return rtrim( strtr( base64_encode( random_bytes( 16 ) ), '+/', '-_' ), '=' );
	}

	/**
	 * One signed POST.
	 *
	 * Returns `array( 'ok' => bool, 'status' => int, 'data' => array, 'error' => string )`
	 * rather than throwing or returning WP_Error directly, because every caller
	 * here has to do the same three things with a failure — log it, record it
	 * on the queue row, carry on with the next item — and a uniform shape is
	 * what lets `class-pos-sync.php` stay readable.
	 */
	public function post( $path, array $payload = array() ) {
		if ( '' === $this->base_url || '' === $this->token ) {
			return $this->failure( 0, 'not_configured' );
		}

		// The body is serialised exactly once and both signed and sent as that
		// same string. Re-encoding before sending would be the classic way to
		// produce a signature over something other than what was transmitted.
		// An empty PHP array would otherwise serialise to `[]`, but the app's
		// plugin-route.ts expects a JSON *object* — and the ping and pull-jobs
		// calls send no payload at all — so those must be `{}`.
		$body      = wp_json_encode( $payload ? $payload : new stdClass() );
		$timestamp = (string) (int) round( microtime( true ) * 1000 );
		$nonce     = $this->nonce();
		$signature = hash_hmac( 'sha256', self::signing_string( $timestamp, $nonce, $body ), $this->token );

		$response = wp_remote_post(
			$this->base_url . $path,
			array(
				'timeout'     => 30,
				'redirection' => 0,
				'headers'     => array(
					'Content-Type'    => 'application/json',
					'Authorization'   => 'Bearer ' . $this->token,
					'X-POS-Timestamp' => $timestamp,
					'X-POS-Nonce'     => $nonce,
					'X-POS-Signature' => $signature,
					'X-POS-Plugin'    => POS_CONNECTOR_VERSION,
				),
				'body'        => $body,
			)
		);

		if ( is_wp_error( $response ) ) {
			return $this->failure( 0, $response->get_error_message() );
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$data   = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( ! is_array( $data ) ) {
			$data = array();
		}

		if ( $status < 200 || $status >= 300 ) {
			// The body rides along on a failure: `site_mismatch` names the address
			// the app expected and `stale_timestamp` carries the app's clock,
			// which is what lets the Test button say how far out this server is.
			return $this->failure( $status, isset( $data['error'] ) ? (string) $data['error'] : 'http_' . $status, $data );
		}

		return array(
			'ok'     => true,
			'status' => $status,
			'data'   => $data,
			'error'  => '',
		);
	}

	private function failure( $status, $error, array $data = array() ) {
		return array(
			'ok'     => false,
			'status' => (int) $status,
			'data'   => $data,
			'error'  => (string) $error,
		);
	}

	/**
	 * Turn an error code from the app into something an operator can act on.
	 *
	 * These are the codes the signed channel produces, and each maps to a
	 * different fix — a wrong token, a wrong clock and a wrong address all
	 * present as "it doesn't work" otherwise.
	 */
	public static function explain( $error ) {
		$map = array(
			'not_configured'   => 'آدرس سامانه یا توکن وارد نشده است.',
			'missing_token'    => 'توکن ارسال نشد. توکن را دوباره وارد کنید.',
			'unauthorized'     => 'توکن پذیرفته نشد. مطمئن شوید توکن را از همان کسب‌وکار کپی کرده‌اید و تعویض نشده باشد.',
			'bad_signature'    => 'امضای درخواست معتبر نبود. معمولاً یعنی توکن ناقص کپی شده است.',
			'stale_timestamp'  => 'ساعت این سرور با سامانه اختلاف زیادی دارد. ساعت و منطقهٔ زمانی سرور را تنظیم کنید.',
			'replayed_nonce'   => 'درخواست تکراری تشخیص داده شد. اگر ادامه داشت، با پشتیبانی تماس بگیرید.',
			'feature_disabled' => 'اتصال فروشگاه آنلاین برای این کسب‌وکار فعال نیست.',
			'site_mismatch'    => 'آدرس این وب‌سایت با آدرسی که برای این اتصال در بیزامیز ثبت شده یکی نیست. اتصال را در بیزامیز برای این سایت جدید تأیید یا توکن را عوض کنید.',
			'paused'           => 'همگام‌سازی از سمت پنل بیزامیز متوقف است.',
			'invalid_json'     => 'پاسخ یا درخواست JSON معتبر نبود.',
			'http_401'         => 'توکن یا امضای درخواست پذیرفته نشد.',
			'http_403'         => 'دسترسی این اتصال در بیزامیز مجاز نیست.',
			'http_413'         => 'حجم داده‌های ارسالی بیش از حد مجاز بود.',
			'http_500'         => 'سامانهٔ بیزامیز خطای داخلی داد. کمی بعد دوباره تلاش کنید.',
			'http_502'         => 'سامانهٔ بیزامیز در دسترس نیست (درگاه). کمی بعد دوباره تلاش کنید.',
			'http_503'         => 'سامانهٔ بیزامیز موقتاً در دسترس نیست. کمی بعد دوباره تلاش کنید.',
			'payload_too_large' => 'حجم داده‌های ارسالی بیش از حد مجاز بود.',
			'http_404'         => 'آدرس سامانه درست نیست (مسیر پیدا نشد).',
			'http_429'         => 'تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.',
		);
		return isset( $map[ $error ] ) ? $map[ $error ] : $error;
	}
}
