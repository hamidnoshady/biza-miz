-- ============================================================================
-- 0211_reporting_integrity.sql — issue #819: shift report integrity
--
-- Two defects in the Phase 8 / Phase 20 shift reporting views:
--
-- 1. v_shift_reconciliation summed `o.total` across a LEFT JOIN to payments
--    (0008, carried verbatim into 0076's app_business_date redefinition). A
--    split-paid order has one payments row per tender, so the join multiplied
--    its gross by the number of payments. `count(DISTINCT o.id)` kept the
--    order count honest and the payment columns are FILTER-guarded (a payment
--    row only feeds the method it matches), but `gross_total` — the number the
--    «تطبیق شیفت» report and rollup-service.ts's daily cash box both show —
--    inflated for exactly the split bills a cashier most wants reconciled. The
--    view is redefined to aggregate payments in a LATERAL subquery, the same
--    shape 0061 already uses in v_employee_shift_reconciliation.
--
-- 2. v_employee_shift_reconciliation attributed an order to a shift purely by
--    `closed_by = shift.employee_id` and the [started_at, ended_at] window
--    (0061). An employee who works in more than one branch of the same
--    business could have an order they closed at branch B counted into their
--    shift at branch A whenever the times overlapped. Orders are now bounded
--    by the shift's own branch as well. An order has no business_id column, so
--    the guard is expressed through its location, and shifts with no location
--    (a business-wide/back-office shift) stay bounded by business only.
--
-- Neither view's column list changes, so CREATE OR REPLACE is safe for every
-- reader (the dashboard reporting catalogue, rollup-service.ts and the
-- standard-report definitions list these columns positionally).
-- ============================================================================

CREATE OR REPLACE VIEW v_shift_reconciliation AS
SELECT
    o.location_id,
    l.business_id,
    app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) AS business_date,
    o.closed_by,
    u.full_name                                 AS cashier_name,
    -- One row per completed order now, so count(*) is both cheaper and exact;
    -- DISTINCT is kept off deliberately rather than to paper over a join.
    count(*)                                    AS order_count,
    sum(o.total)                                AS gross_total,
    coalesce(sum(pay.cash), 0)                  AS cash_total,
    coalesce(sum(pay.card), 0)                  AS card_total,
    coalesce(sum(pay.online), 0)                AS online_total,
    coalesce(sum(pay.credit), 0)                AS credit_total
FROM orders o
JOIN locations l ON l.id = o.location_id
LEFT JOIN users u ON u.id = o.closed_by
-- Payments are aggregated in their own subquery rather than joined alongside
-- orders: joining them before summing o.total multiplies a split-paid order's
-- gross by its payment count (the bug above).
LEFT JOIN LATERAL (
    SELECT
        coalesce(sum(p.amount) FILTER (WHERE p.method = 'cash'), 0)                     AS cash,
        coalesce(sum(p.amount) FILTER (WHERE p.method IN ('card', 'card_to_card')), 0)  AS card,
        coalesce(sum(p.amount) FILTER (WHERE p.method = 'online'), 0)                   AS online,
        coalesce(sum(p.amount) FILTER (WHERE p.method = 'credit'), 0)                   AS credit
    FROM payments p
    WHERE p.order_id = o.id
) pay ON true
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL
GROUP BY o.location_id, l.business_id,
         app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes),
         o.closed_by, u.full_name;

-- CREATE OR REPLACE VIEW keeps the existing security_invoker reloption, but
-- re-asserting it is cheap and makes the RLS posture explicit at the point the
-- definition is re-created (integration/tenant-isolation.integration.test.ts
-- asserts every reporting view runs with the invoker's rights).
ALTER VIEW v_shift_reconciliation SET (security_invoker = on);

CREATE OR REPLACE VIEW v_employee_shift_reconciliation AS
SELECT
    s.id                                        AS shift_id,
    s.business_id,
    s.location_id,
    s.business_date,
    s.started_at,
    s.ended_at,
    to_char(s.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        || '~'
        || coalesce(to_char(s.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '')
                                                AS shift_window,
    s.employee_id,
    u.full_name                                 AS employee_name,
    s.opening_float,
    s.closing_float,
    round(
        extract(epoch FROM (coalesce(s.ended_at, now()) - s.started_at)) / 60.0
    )                                           AS duration_minutes,
    coalesce(sales.order_count, 0)              AS order_count,
    coalesce(sales.gross_total, 0)              AS gross_total,
    coalesce(sales.cash_total, 0)               AS cash_total,
    coalesce(sales.card_total, 0)               AS card_total,
    coalesce(sales.online_total, 0)             AS online_total,
    coalesce(sales.credit_total, 0)             AS credit_total,
    CASE
        WHEN s.closing_float IS NULL THEN NULL
        ELSE s.closing_float - (coalesce(s.opening_float, 0) + coalesce(sales.cash_total, 0))
    END                                         AS cash_variance
FROM employee_shifts s
JOIN users u ON u.id = s.employee_id
LEFT JOIN LATERAL (
    -- Payments are summed in their own scalar subquery rather than joined
    -- alongside orders: a split-paid order has several payments rows, and
    -- joining them before summing o.total would multiply the order's gross
    -- by its payment count.
    SELECT
        count(*)                    AS order_count,
        coalesce(sum(o.total), 0)   AS gross_total,
        coalesce(sum(pay.cash), 0)  AS cash_total,
        coalesce(sum(pay.card), 0)  AS card_total,
        coalesce(sum(pay.online), 0) AS online_total,
        coalesce(sum(pay.credit), 0) AS credit_total
    FROM orders o
    JOIN locations ol ON ol.id = o.location_id
    LEFT JOIN LATERAL (
        SELECT
            coalesce(sum(p.amount) FILTER (WHERE p.method = 'cash'), 0)   AS cash,
            coalesce(sum(p.amount) FILTER (WHERE p.method IN ('card', 'card_to_card')), 0) AS card,
            coalesce(sum(p.amount) FILTER (WHERE p.method = 'online'), 0) AS online,
            coalesce(sum(p.amount) FILTER (WHERE p.method = 'credit'), 0) AS credit
        FROM payments p
        WHERE p.order_id = o.id
    ) pay ON true
    WHERE o.closed_by = s.employee_id
      AND o.status = 'completed'
      AND o.closed_at IS NOT NULL
      AND o.closed_at >= s.started_at
      AND o.closed_at <= coalesce(s.ended_at, now())
      -- Branch boundary: the shift's own branch, when it has one. Without
      -- this an employee clocked in at branch B could have their branch-B
      -- orders counted into a branch-A shift whose window overlaps.
      AND (s.location_id IS NULL OR o.location_id = s.location_id)
      -- Orders carry no business_id, so a location-less shift is bounded
      -- through the order's location instead — never against the whole
      -- database.
      AND ol.business_id = s.business_id
) sales ON true;

ALTER VIEW v_employee_shift_reconciliation SET (security_invoker = on);
