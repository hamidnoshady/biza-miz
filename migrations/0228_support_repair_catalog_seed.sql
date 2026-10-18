-- 0228_support_repair_catalog_seed.sql
--
-- Issue #984 — the initial repair catalog: companion-owned housekeeping and
-- one explicitly approved verified runtime recovery recipe. Seeded INACTIVE:
-- activation is the audited, owner-only, MFA'd publish step
-- (`support.repair.publish`), never a silent default. Hashes are sha256 over
-- the canonicalised recipe JSON (see `canonicalRecipeJson`); the service
-- re-verifies them before any execution.
--
-- Sorts after 0228_support_companion_foundation.sql, which creates the table.

INSERT INTO support_repair_catalog
  (recipe_id, version, title, description, risk, compatibility, preconditions,
   effects, postchecks, backup_policy, recipe, recipe_hash, active)
VALUES
  ('companion.clean_temp', 1,
   'پاک‌سازی فایل‌های موقت همراه',
   'حذف فایل‌های موقت متعلق به همراه (قدیمی‌تر از ۷ روز). ژورنال، گزارش‌ها و داده کسب‌وکار دست نخورده می‌ماند.',
   'low',
   '{"platform": ["windows"]}',
   '[{"check": "root_owned", "detail": "companion_temp"}, {"check": "dry_run_first"}]',
   '[{"effect": "delete_companion_temp_older_than_days", "days": 7}]',
   '[{"check": "journal_intact"}, {"check": "reports_intact"}]',
   'none',
   '{"action": "companion.clean_temp", "params": {"maxAgeDays": 7, "roots": ["companion_temp"]}}',
   'ba74ad2b84b51556b140aa9170c414abdd951ecc157399f7b632783c815a45f2',
   false),
  ('companion.rotate_logs', 1,
   'چرخش لاگ‌های همراه',
   'نگه‌داشت ۱۰ فایل لاگ اخیر همراه و حذف مابقی. گزارش‌ها و ژورنال عملیات دست نخورده می‌ماند.',
   'low',
   '{"platform": ["windows"]}',
   '[{"check": "root_owned", "detail": "companion_logs"}]',
   '[{"effect": "rotate_companion_logs", "keepFiles": 10}]',
   '[{"check": "log_write_ok"}]',
   'none',
   '{"action": "companion.rotate_logs", "params": {"keepFiles": 10}}',
   'def201fe2839679211c802746c84340b9b60a50cf4802185a9c2a32a2cebbd7e',
   false),
  ('main.restart_backend', 1,
   'راه‌اندازی مجدد بک‌اند اصلی',
   'راه‌اندازی مجدد بک‌اند تأییدشده نصب با دروازه نگهداشت نصب؛ بدون مهاجرت و بدون تغییر داده.',
   'medium',
   '{"platform": ["windows"]}',
   '[{"check": "installation_gate_free"}, {"check": "no_active_orders_or_uploads"}, {"check": "process_identity_verified"}]',
   '[{"effect": "restart_verified_backend", "timeoutSec": 120}]',
   '[{"check": "web_liveness_ok"}, {"check": "desktop_instance_match"}]',
   'checkpoint',
   '{"action": "main.restart_backend", "params": {"requireGate": true, "timeoutSec": 120}}',
   '466f770b14207ee2280555749bd9f42e30c9585f627b3b3a721715e30b1ff7a7',
   false)
ON CONFLICT (recipe_id, version) DO NOTHING;
