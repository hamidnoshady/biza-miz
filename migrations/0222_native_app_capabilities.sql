-- ---------------------------------------------------------------------------
-- 0222_native_app_capabilities.sql — Issue #884 Android TWA runtime v3
--
-- Extends `native_app_devices` (0216, 0217) with push-notification registration
-- state, reported native capability set, biometric opt-in/verification timestamp,
-- caller-ID role status, and background sync heartbeat so device revocation
-- atomically invalidates push delivery and native background sync on the same row.
-- Also seeds the Android capability flags in `feature_flags`.
-- ---------------------------------------------------------------------------

ALTER TABLE native_app_devices
  ADD COLUMN IF NOT EXISTS push_token text
    CHECK (push_token IS NULL OR char_length(push_token) BETWEEN 16 AND 4096),
  ADD COLUMN IF NOT EXISTS push_provider text
    CHECK (push_provider IS NULL OR push_provider IN ('fcm', 'webpush', 'none')),
  ADD COLUMN IF NOT EXISTS push_channels jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS push_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS biometric_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS biometric_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS caller_id_role_held boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_sync_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_native_app_devices_active_push
  ON native_app_devices (business_id, user_id)
  WHERE revoked_at IS NULL AND push_token IS NOT NULL;

INSERT INTO feature_flags (key, name, description, default_enabled) VALUES
  ('android_caller_id', 'تشخیص تماس مشتریان در اندروید',
   'نمایش نام و سابقهٔ مشتری هنگام تماس ورودی و ثبت سریع نتیجهٔ تماس در CRM',
   true),
  ('android_native_print', 'چاپ مستقیم اندروید',
   'چاپ رسید، برچسب و فاکتور از طریق سرویس چاپ اندروید، شبکه و چاپگرهای حرارتی بلوتوث',
   true),
  ('android_document_scanner', 'اسکنر بارکد و مدارک اندروید',
   'اسکن سریع بارکد، QR و تصویربرداری مدارک با دوربین دستگاه اندرویدی',
   true),
  ('android_biometric', 'ورود و قفل بیومتریک اندروید',
   'تأیید هویت سریع با اثر انگشت یا تشخیص چهرهٔ اندروید بدون تضعیف نشست سرور',
   true),
  ('android_voip', 'تماس اینترنتی (VoIP) اندروید',
   'زیرساخت تماس اینترنتی درون‌برنامه‌ای در نسخهٔ اندروید',
   false)
ON CONFLICT (key) DO NOTHING;
