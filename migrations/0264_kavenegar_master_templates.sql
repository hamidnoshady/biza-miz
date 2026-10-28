-- Issue #902 §5 — the centrally approved template library.
--
-- §5 asks for three things the per-business catalog could not do on its own:
--
--   * "Allow Superadmin enable/disable catalog entries by business type /
--     channel / plan." A business-type rule needs a catalog that exists
--     independently of any business, which is what this table is: the platform's
--     own message library, keyed by a stable `key` (`login_code`, `order_ready`).
--   * "Business-supplied name/amount/order info maps to approved variables, not
--     arbitrary backend syntax." A template therefore declares the ordered
--     domain variables it accepts (`variables`), and the value that reaches the
--     provider is produced by the renderer in `template-variables.ts` — never the
--     raw string a caller passed.
--   * "Updating master template must support safe versioned rollout and
--     reapproval without breaking active sends." `version` moves when the
--     message itself changes; a business's copy records which version it was
--     instantiated from, and the existing revision flow (0260) keeps the
--     business's approved template live while a successor is reviewed.
--
-- The library is **platform-owned and platform-only**. A tenant never reads this
-- table directly: it sees the eligible subset through its own catalog
-- (`kavenegar_lookup_templates`), in first-party words, with the provider's
-- template identity nowhere in the response. `industries`/`plans` are targeting
-- rules; an empty array means "every trade" / "every plan", which is the case
-- for a login code that every business needs regardless of what it sells.

CREATE TABLE kavenegar_master_templates (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Machine handle, stable across renames: the console shows `title`, the
    -- code and the instantiate path use `key`.
    key          text NOT NULL,
    title        text NOT NULL,
    -- The message as the provider will approve it, with `%token` slots. Bodies
    -- are shared verbatim with the business's copy so an approved library entry
    -- is an approved business template.
    body         text NOT NULL,
    purpose      text NOT NULL DEFAULT 'transactional'
        CHECK (purpose IN ('verification', 'transactional')),
    -- Ordered: position 0 fills `%token`, 1 fills `%token2`, 2 fills `%token3`.
    -- Names come from the fixed registry in `template-variables.ts`; the CHECK
    -- keeps the row honest even for a hand-written INSERT.
    variables    text[] NOT NULL DEFAULT '{}',
    industries   text[] NOT NULL DEFAULT '{}',
    plans        text[] NOT NULL DEFAULT '{}',
    enabled      boolean NOT NULL DEFAULT true,
    version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
    notes        text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   uuid,
    CONSTRAINT kavenegar_master_templates_key_unique UNIQUE (key),
    CONSTRAINT kavenegar_master_templates_key_format CHECK (key ~ '^[a-z][a-z0-9_]{2,63}$'),
    CONSTRAINT kavenegar_master_templates_title CHECK (length(btrim(title)) BETWEEN 1 AND 80),
    CONSTRAINT kavenegar_master_templates_token CHECK (strpos(body, '%token') > 0),
    CONSTRAINT kavenegar_master_templates_variables CHECK (
        cardinality(variables) BETWEEN 1 AND 3
        AND variables <@ ARRAY['code', 'customer_name', 'store_name', 'order_number', 'amount', 'date']::text[]
    )
);

COMMENT ON TABLE kavenegar_master_templates IS
    'Issue #902 §5: the platform''s approved message library, targeted at trades/plans. Platform-only; tenants see instantiated copies.';
COMMENT ON COLUMN kavenegar_master_templates.variables IS
    'Ordered domain variables: position 0 fills %token, 1 fills %token2, 2 fills %token3. Rendered by template-variables.ts, never interpolated raw.';
COMMENT ON COLUMN kavenegar_master_templates.industries IS
    'businesses.industry values this entry is offered to. Empty = every trade.';
COMMENT ON COLUMN kavenegar_master_templates.plans IS
    'billing plan keys this entry is offered to. Empty = every plan.';
COMMENT ON COLUMN kavenegar_master_templates.version IS
    'Moves when the message changes, so a business copy can say which version it came from.';

ALTER TABLE kavenegar_master_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE kavenegar_master_templates FORCE ROW LEVEL SECURITY;
-- No business_id column and no tenant policy: the library is the platform's
-- editorial artifact. A tenant reaches it only by instantiating a copy into its
-- own catalog, resolved server-side against its trade and plan.
CREATE POLICY platform_only ON kavenegar_master_templates FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

-- Which library entry a business copy came from, and which version of it.
-- ON DELETE SET NULL: withdrawing an entry must not delete messages a business
-- is already sending — the copy keeps working, it just loses its origin.
ALTER TABLE kavenegar_lookup_templates
    ADD COLUMN master_template_id uuid REFERENCES kavenegar_master_templates(id) ON DELETE SET NULL,
    ADD COLUMN master_version integer;

CREATE INDEX idx_kavenegar_lookup_templates_master
    ON kavenegar_lookup_templates (master_template_id)
    WHERE master_template_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Starter library
-- ---------------------------------------------------------------------------
-- Three messages every managed-SMS business needs, written the way the
-- provider's approval rules require: one Persian sentence, `%token` present,
-- inside a single segment. They are seeded **disabled for nobody and targeted at
-- nobody in particular** (empty arrays = every trade, every plan) because a
-- login code is not a matter of what the business sells. An operator may
-- narrow or disable them from the console; the rows exist so the library has
-- something truthful in it on the day the console ships.

INSERT INTO kavenegar_master_templates (key, title, body, purpose, variables, notes) VALUES
    ('login_code',
     'کد ورود',
     'کد ورود شما به بیزامیز: %token',
     'verification',
     ARRAY['code'],
     'ورود و تأیید هویت؛ کد باید فقط شامل رقم باشد و هرگز در لاگ ذخیره نشود.'),
    ('order_ready',
     'آمادهٔ تحویل سفارش',
     '%token عزیز، سفارش شما در %token2 آمادهٔ تحویل است.',
     'transactional',
     ARRAY['customer_name', 'store_name'],
     'اطلاع‌رسانی وضعیت سفارش؛ نام مشتری و نام فروشگاه از دادهٔ خود کسب‌وکار می‌آید.'),
    ('payment_received',
     'دریافت پرداخت',
     'پرداخت %token ریالی شما در %token2 ثبت شد.',
     'transactional',
     ARRAY['amount', 'store_name'],
     'رسید پرداخت؛ مبلغ با رقم فارسی و جداکنندهٔ هزارگان رندر می‌شود.')
ON CONFLICT (key) DO NOTHING;
