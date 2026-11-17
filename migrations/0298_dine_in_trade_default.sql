-- ESH-147 follow-up: `dine_in` must not appear in trades that have no tables.
--
-- 0297 added the flag with `default_enabled = true` so that upgrading a
-- restaurant never silently lost table service: before this pair of changes,
-- dine-in was allowed exactly when `reservations` was on, and almost every F&B
-- business carries no explicit `reservations` row. The same default, however,
-- is read by trades provisioned with `reservations` off on purpose (jewellery,
-- retail, services), and those businesses would wake up to a POS dine-in tab
-- and a table-service surface they never bought.
--
-- Two pieces make the default safe:
--   1. this migration mirrors every *explicit* `reservations` choice onto
--      `dine_in`, so an existing business keeps exactly the table service it
--      had before the upgrade (both the on and the off rows);
--   2. business provisioning disables `dine_in` for non-F&B industries, so a
--      shop created after this migration starts without it.
--
-- A business with no `reservations` row keeps the `default_enabled = true`
-- result, which is what it effectively had (dine-in was never refused for it).
INSERT INTO business_features (business_id, flag_key, enabled)
SELECT r.business_id, 'dine_in', r.enabled
  FROM business_features r
 WHERE r.flag_key = 'reservations'
ON CONFLICT (business_id, flag_key) DO NOTHING;
