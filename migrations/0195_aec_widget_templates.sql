-- Issue #799 §22 — the AEC industry's recommended AI widgets.
--
-- The widget catalogue (`ai_widget_templates`) is the platform's, not a
-- tenant's: rows with `business_id IS NULL` are templates every business of
-- that industry is *offered*, and
-- `listRecommendedAiWidgets(industry, permissions)` filters them by industry
-- and by what the caller may see. Migration 0188 seeded the F&B pair and two
-- `all` rows; this adds the AEC ones.
--
-- Three widgets, not the issue's thirteen examples. §22's list names sections
-- that do not exist yet — RFIs, submittals, payment certificates, procurement
-- delays, drawing revisions, project margin are Waves 4–9 — and a recommended
-- widget for a section with no data is a prompt that can only hallucinate.
-- What is offered here is what `workspace_approvals`, `workspace_contracts`
-- and the project register can actually answer today; the rest arrive with the
-- waves that build their data.
--
-- Idempotent on purpose (the repo's standing rule for migrations): the insert
-- is guarded per (industry, name), so re-applying it adds nothing.

INSERT INTO ai_widget_templates
  (name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height, created_by)
SELECT v.name, v.description, v.industry, v.source_app, v.required_permissions, v.prompt, v.output_format, v.default_width, v.default_height, 'system'
  FROM (VALUES
    (
      'پروژه‌های در معرض خطر',
      'پروژه‌هایی که کار عقب‌افتاده یا پایان نزدیک دارند',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.view']::text[],
      'از میان پروژه‌های فعال، آن‌هایی که وظیفهٔ عقب‌افتاده دارند یا تاریخ پایانشان نزدیک است را با دلیل کوتاه فهرست کن. نام پروژه، تعداد کار عقب‌افتاده و روزهای باقی‌مانده را بنویس.',
      'bullets',
      2,
      1
    ),
    (
      'تأییدهای در انتظار',
      'درخواست‌هایی که منتظر تصمیم شما هستند',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.approve']::text[],
      'درخواست‌های تأیید در انتظار را با موضوع، درخواست‌کننده و مهلتشان فهرست کن و بگو کدام‌ها فوری‌ترند.',
      'bullets',
      1,
      1
    ),
    (
      'قراردادهای نزدیک به پایان',
      'قراردادهایی که باید تمدید یا تعیین تکلیف شوند',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.view']::text[],
      'قراردادهای در جریان پروژه‌ها را بررسی کن و آن‌هایی که تاریخ پایانشان نزدیک است یا گذشته را با نام طرف، ارزش قرارداد و روزهای باقی‌مانده بنویس.',
      'bullets',
      2,
      1
    )
  ) AS v(name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height)
 WHERE NOT EXISTS (
   SELECT 1 FROM ai_widget_templates t
    WHERE t.industry = v.industry AND t.name = v.name
 );
