-- Issue #799 §22 (Wave 10) — the recommended AEC widgets §30's reports and §23's
-- twelfth read made answerable.
--
-- §22 names thirteen examples. Migration 0195 seeded three (Projects at Risk,
-- Pending Approvals, Contract Expiry) and explained the rule: a recommended
-- widget for a section with no data is a prompt that can only hallucinate, so
-- the catalogue grows with the registers. Waves 5–9 added eight more (drawing
-- revisions, RFIs, submittals, site day and open site issues, pending
-- certificates, commercial risk, procurement delay). The three added here are
-- the ones the last two waves unblocked:
--
--   * **«نقاط عطف پیش رو» (Upcoming Milestones)** — needed a read of what is
--     *coming*; `list_delayed_project_activities` only answers what has already
--     slipped, so Wave 10 added `list_upcoming_milestones` (phase end dates,
--     open task due dates and project end dates inside a window, soonest first).
--   * **«سررسید ضمانت‌نامه‌ها» (Guarantee/Bond Expiry)** — §17's securities
--     register and `list_project_commercial_risks`' `withinDays` window are what
--     §23's own Persian question («کدام قراردادها یا ضمانت‌نامه‌ها تا ماه بعد
--     منقضی می‌شوند؟») reads; the widget is that question, pinned.
--   * **«حاشیهٔ پروژه» (Project Margin)** — deliberately *not* seeded in Wave 8,
--     because a margin without a visible basis is a wrong number. §20's forecast
--     now exists and §30's «هزینهٔ نهایی پیش‌بینی‌شده» card prints
--     `forecastBasis` on screen, which is exactly the condition the phase doc
--     recorded. The prompt therefore tells the assistant to state the basis and
--     to say «قابل محاسبه نیست» when the estimate or the ledger is unreadable
--     rather than to compute one.
--
-- These are **recommendations**, not installations: `ai_widget_templates` rows
-- are platform rows (`business_id IS NULL`) that a business is *offered* through
-- `listRecommendedAiWidgets`, and a user adding their own `ai_widgets` row is
-- unaffected by anything here — §22's \"super-admin should be able to provide
-- recommended industry widgets without preventing users from creating their
-- own\", which the platform console's «ویجت‌های پیشنهادی» page now administers
-- (create/edit/enable per industry) without touching tenant rows.
--
-- Idempotent on purpose (the repo's standing rule for migrations): guarded per
-- (industry, name), so re-applying it adds nothing.

INSERT INTO ai_widget_templates
  (name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height, created_by)
SELECT v.name, v.description, v.industry, v.source_app, v.required_permissions, v.prompt, v.output_format, v.default_width, v.default_height, 'system'
  FROM (VALUES
    (
      'نقاط عطف پیش رو',
      'تاریخ پایان فازها، موعد وظایف باز و پایان پروژه‌ها در ۳۰ روز آینده',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.view']::text[],
      'با ابزار list_upcoming_milestones نقاط عطف ۳۰ روز آینده را فهرست کن: نام پروژه، عنوان فاز یا وظیفه، تاریخ شمسی و چند روز مانده. اگر فازی نزدیک پایان است بگو چند کار از آن انجام شده. اگر چیزی در این بازه نیست، همان را بگو و تاریخ‌های دورتر را حدس نزن.',
      'bullets',
      2,
      1
    ),
    (
      'سررسید ضمانت‌نامه‌ها',
      'ضمانت‌نامه‌ها و بیمه‌نامه‌هایی که تا ۶۰ روز آینده سررسید می‌شوند',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.view']::text[],
      'با ابزار list_project_commercial_risks و پنجرهٔ whenیروز (withinDays=۶۰) ضمانت‌نامه‌ها و بیمه‌نامه‌های نزدیک به انقضا را بنویس: پروژه، طرف، نوع، مبلغ، تاریخ سررسید شمسی و روزهای باقی‌مانده. تأکید کن که تمدید یا آزادسازی سند در حسابداری ثبت می‌شود و اینجا فقط هشدار سررسید است.',
      'bullets',
      1,
      1
    ),
    (
      'حاشیهٔ پروژه',
      'حاشیهٔ پیش‌بینی‌شدهٔ پروژه بر پایهٔ هزینهٔ ثبت‌شده، تعهدات و برآورد مصوب',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.view']::text[],
      'با ابزار get_aec_project_financial_health حاشیهٔ پیش‌بینی‌شدهٔ پروژه‌ها را بنویس: ارزش اصلاح‌شدهٔ قرارداد، هزینهٔ نهایی پیش‌بینی‌شده، حاشیه به ریال و درصد، و مبنای محاسبه را همان‌طور که ابزار می‌دهد نقل کن. هزینهٔ ثبت‌شده فقط از حسابداری خوانده می‌شود؛ اگر دفتر یا برآورد مصوب در دسترس نیست بگو «قابل محاسبه نیست» و خودت عدد نساز.',
      'metric',
      2,
      1
    )
  ) AS v(name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height)
 WHERE NOT EXISTS (
   SELECT 1 FROM ai_widget_templates t
    WHERE t.industry = v.industry AND t.name = v.name
 );
