-- ============================================================================
-- 0264_billing_purchase_fulfilment.sql — billing access overlap audit
--
-- 1. billing_payments.plan_activated_at: the moment a verified plan purchase
--    moved (or extended) the subscription. changeBusinessPlan stamps it in the
--    SAME transaction as the subscription write, so a retry of an incomplete
--    fulfilment (or two concurrent callbacks) can never extend the period a
--    second time for one payment.
-- 2. Clarified descriptions for the six look-alike feature keys, so the
--    console shows which side of a pair is the gate and which the commercial
--    row (see src/lib/feature-catalogue.ts). Keys and defaults are untouched.
-- ============================================================================

ALTER TABLE billing_payments
    ADD COLUMN IF NOT EXISTS plan_activated_at timestamptz;

-- A payment whose fulfilment already succeeded has, by definition, been applied.
UPDATE billing_payments
   SET plan_activated_at = COALESCE(fulfilled_at, verified_at, now())
 WHERE purpose = 'plan_purchase'
   AND fulfilment_status = 'succeeded'
   AND plan_activated_at IS NULL;

UPDATE feature_flags SET description = 'قفل مسیرهای انبار رستوران/کافه. نام تجاری همین قابلیت در بستهٔ پلن: accounting.inventory'
 WHERE key = 'inventory';
UPDATE feature_flags SET description = 'قابلیت انبار در بستهٔ پلن حسابداری. قفل مسیرها با کلید inventory انجام می‌شود'
 WHERE key = 'accounting.inventory';
UPDATE feature_flags SET description = 'قفل مسیرهای دفتر و حسابداری. نام تجاری همین قابلیت در بستهٔ پلن: accounting.ledger'
 WHERE key = 'ledger';
UPDATE feature_flags SET description = 'قابلیت دفتر در بستهٔ پلن حسابداری. قفل مسیرها با کلید ledger انجام می‌شود'
 WHERE key = 'accounting.ledger';
UPDATE feature_flags SET description = 'قفل مسیرهای گزارش. نام تجاری همین قابلیت در بستهٔ پلن: accounting.reports'
 WHERE key = 'reporting';
UPDATE feature_flags SET description = 'قابلیت گزارش در بستهٔ پلن حسابداری. قفل مسیرها با کلید reporting انجام می‌شود'
 WHERE key = 'accounting.reports';
UPDATE feature_flags SET description = 'قفل کلید API توسعه‌دهنده، وب‌هوک و اتصال MCP (پیش‌فرض خاموش). نام تجاری: integrations.api'
 WHERE key = 'api_platform';
UPDATE feature_flags SET description = 'API و اتصال‌های فنی در بستهٔ پلن. قفل دسترسی با کلید api_platform انجام می‌شود'
 WHERE key = 'integrations.api';
UPDATE feature_flags SET description = 'دسترسی به دستیار هوشمند (پیش‌فرض خاموش). هزینهٔ مصرف با کلید ai از کیف پول برداشت می‌شود'
 WHERE key = 'ai_assistant';
UPDATE feature_flags SET description = 'کلید اندازه‌گیری و برداشت مصرف هوش مصنوعی از کیف پول. دسترسی به دستیار با کلید ai_assistant تعیین می‌شود'
 WHERE key = 'ai';
UPDATE feature_flags SET description = 'اتصال فروشگاه ووکامرس/وردپرس (پیش‌فرض خاموش). با هزینهٔ سایت‌ساز website_service یکی نیست'
 WHERE key = 'integrations';
UPDATE feature_flags SET description = 'هزینهٔ سایت‌ساز بیزامیز از کیف پول. با اتصال ووکامرس (integrations) یکی نیست'
 WHERE key = 'website_service';
