-- ============================================================================
-- 0241_shift_cashup_integrity.sql — issue #933: Settings → شیفت‌ها و روز کاری
--
-- The audit behind #933 found four financial-integrity defects in the shift
-- feature, and this migration is the durable half of the fix:
--
--   1. A shift's cash-up was never stored. `employee_shifts.ended_at` was
--      committed and the closing cash summary was *then* read back from
--      `orders`/`payments`, so a later amendment, refund or reversal silently
--      changed a closed shift's variance. `shift_cashups` is the immutable
--      closing snapshot: tenders by class, expected/counted/variance, the
--      closer, the branch and the reason an unresolved close has none of it.
--      Corrections are append-only rows in `shift_cashup_adjustments`, with
--      before/after values and a mandatory reason — never an UPDATE of the
--      finalized snapshot (enforced by a trigger, not just by convention).
--
--   2. "Expected cash" was `opening float + cash settlements`, which pretends
--      that no cash ever enters or leaves a drawer except by a sale.
--      `shift_cash_movements` records paid-outs, floats brought in, safe drops
--      and handovers with a reason and an actor, so the expectation can be
--      explained line by line.
--
--   3. `business_day_closures` had no uniqueness, so two concurrent closes
--      could both pass the "already closed?" precheck and both insert; a
--      reopen then deleted *every* closure in the scheduled range. The table
--      now keeps history (`reopened_at` instead of a DELETE) and has a partial
--      unique index that makes one active closure per branch per business day
--      a database guarantee.
--
--   4. Legacy shifts with no branch were treated as belonging to *every*
--      branch by predicates like `location_id = $1 OR location_id IS NULL`.
--      `app_shift_attribution_branch` resolves such a row to the one branch it
--      can be attributed to — its employee's home branch, their only assigned
--      branch, or the business's only branch — and returns NULL (an explicit
--      unknown) rather than every branch.
--
-- Deliberately no changes to the reporting engine (#819) or to the accounting
-- reconciliation area (#830). `v_employee_shift_reconciliation` is touched only
-- to prefer the finalized snapshot it now has, which is the shift report's own
-- root cause.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Idempotent shift starts
-- ---------------------------------------------------------------------------
-- A start request that is retried after its transaction committed used to hit
-- `idx_employee_shifts_employee_open` and answer `shift_already_open`, which
-- reads as a failure even though the shift exists. The caller may now send an
-- idempotency key; the unique index below makes a replay find its own shift
-- instead of a stranger's.
ALTER TABLE employee_shifts
    ADD COLUMN IF NOT EXISTS open_request_id text,
    -- The same idea for the close: a close retried after its transaction
    -- committed finds the shift and its cash-up by this key instead of
    -- answering `no_active_shift` for a shift it already closed.
    ADD COLUMN IF NOT EXISTS close_request_id text,
    -- 'counted' | 'unresolved' — mirrors shift_cashups.close_mode and lets the
    -- history list say "closed without a count" without a join.
    ADD COLUMN IF NOT EXISTS close_mode text
        CHECK (close_mode IS NULL OR close_mode IN ('counted', 'unresolved'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_shifts_open_request
    ON employee_shifts (business_id, open_request_id)
    WHERE open_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_shifts_close_request
    ON employee_shifts (business_id, close_request_id)
    WHERE close_request_id IS NOT NULL;

-- The closing cash-up references its shift by (id, business_id), the composite
-- key shape migration 0045 established for every other Wave 1-5 table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'employee_shifts_id_business_unique'
       AND conrelid = 'employee_shifts'::regclass
  ) THEN
    ALTER TABLE employee_shifts
      ADD CONSTRAINT employee_shifts_id_business_unique UNIQUE (id, business_id);
  END IF;
END $$;

-- History is read per branch, newest first.
CREATE INDEX IF NOT EXISTS idx_employee_shifts_location_started
    ON employee_shifts (business_id, location_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Which branch does a shift belong to?
-- ---------------------------------------------------------------------------
-- A shift only records a branch when the session that opened it had one, so
-- rows written before that fallback existed carry `location_id IS NULL`. The
-- old answer was "every branch", which let one branch's cash-up reset another
-- branch's reporting window. The answer now is the single branch the row can
-- be attributed to, or NULL — an unknown that matches no branch rather than
-- all of them.
--
-- Order of evidence:
--   1. the shift's own location;
--   2. the employee's home branch (`users.location_id`) when it is active in
--      this business — the same branch migration 0170 calls the default;
--   3. their only `user_locations` assignment, when they have exactly one;
--   4. the business's only active branch, when it has exactly one.
--
-- STABLE, not IMMUTABLE: it reads tables. SECURITY INVOKER is the default and
-- is deliberate — under the app role it resolves only rows the caller's tenant
-- policy already allows.
CREATE OR REPLACE FUNCTION app_shift_attribution_branch(
    p_business uuid,
    p_location uuid,
    p_employee uuid
) RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN p_location IS NOT NULL THEN p_location
        ELSE coalesce(
            (SELECT u.location_id
               FROM users u
               JOIN locations hl ON hl.id = u.location_id AND hl.business_id = p_business
              WHERE u.id = p_employee
                AND u.business_id = p_business
                AND u.location_id IS NOT NULL
              LIMIT 1),
            -- PostgreSQL does not define min(uuid). Since HAVING guarantees a
            -- single assignment, the first (and only) array element is that
            -- UUID without imposing an arbitrary ordering.
            (SELECT (array_agg(ul.location_id))[1]
               FROM user_locations ul
               JOIN locations al ON al.id = ul.location_id AND al.business_id = p_business
              WHERE ul.user_id = p_employee
             HAVING count(*) = 1),
            (SELECT only_branch.id
               FROM (SELECT count(*) AS n
                       FROM locations
                      WHERE business_id = p_business AND is_active) c
               CROSS JOIN LATERAL (
                   SELECT id FROM locations
                    WHERE business_id = p_business AND is_active
                    ORDER BY created_at
                    LIMIT 1
               ) only_branch
              WHERE c.n = 1)
        )
    END
$$;

-- ---------------------------------------------------------------------------
-- The immutable cash-up snapshot
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_cashups (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id         uuid,
    shift_id            uuid NOT NULL,
    employee_id         uuid NOT NULL,
    business_date       date NOT NULL,
    started_at          timestamptz NOT NULL,
    ended_at            timestamptz NOT NULL,
    closed_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    -- 'counted' = somebody physically counted the drawer; 'unresolved' = the
    -- shift was closed without a count (or without an opening float to compare
    -- against). An unresolved close has counted_cash/variance NULL — never 0,
    -- which would look like a reconciled drawer nobody looked at.
    close_mode          text NOT NULL CHECK (close_mode IN ('counted', 'unresolved')),
    close_reason        text,
    opening_float       bigint CHECK (opening_float IS NULL OR opening_float >= 0),
    expected_cash       bigint,
    counted_cash        bigint CHECK (counted_cash IS NULL OR counted_cash >= 0),
    variance            bigint,
    cash_in             bigint NOT NULL DEFAULT 0 CHECK (cash_in >= 0),
    cash_out            bigint NOT NULL DEFAULT 0 CHECK (cash_out >= 0),
    order_count         integer NOT NULL DEFAULT 0 CHECK (order_count >= 0),
    gross_total         bigint NOT NULL DEFAULT 0,
    -- One column per settlement class the ledger knows (payment_method enum,
    -- migration 0091). `cheque` is deliberately its own bucket, never folded
    -- into cash: a cheque is not a till tender. `snappfood` stops being an
    -- unexplained gap between gross and the method buckets.
    tender_cash         bigint NOT NULL DEFAULT 0,
    tender_card         bigint NOT NULL DEFAULT 0,
    tender_card_to_card bigint NOT NULL DEFAULT 0,
    tender_online       bigint NOT NULL DEFAULT 0,
    tender_credit       bigint NOT NULL DEFAULT 0,
    tender_snappfood    bigint NOT NULL DEFAULT 0,
    tender_cheque       bigint NOT NULL DEFAULT 0,
    tender_other        bigint NOT NULL DEFAULT 0,
    breakdown           jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT shift_cashups_shift_business_fk
        FOREIGN KEY (shift_id, business_id)
        REFERENCES employee_shifts (id, business_id)
        ON DELETE CASCADE,
    CONSTRAINT shift_cashups_location_business_fk
        FOREIGN KEY (location_id, business_id)
        REFERENCES locations (id, business_id)
        ON DELETE SET NULL,
    CONSTRAINT shift_cashups_one_per_shift UNIQUE (shift_id),
    CONSTRAINT shift_cashups_ended_after_started CHECK (ended_at >= started_at),
    -- A counted close must have a count; an unresolved close must not invent
    -- one. This is the database half of issue #933 item 10.
    CONSTRAINT shift_cashups_count_matches_mode CHECK (
        (close_mode = 'counted' AND counted_cash IS NOT NULL)
        OR (close_mode = 'unresolved' AND counted_cash IS NULL AND variance IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_shift_cashups_branch_date
    ON shift_cashups (business_id, location_id, business_date DESC);

ALTER TABLE shift_cashups ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_cashups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shift_cashups FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- The finalized snapshot is immutable. Corrections are rows in
-- shift_cashup_adjustments (below), each one audited with before/after values.
-- UPDATE is refused outright; DELETE is left to the tenant-cascade path (a
-- business deletion removes its own history), which no app code path performs.
CREATE OR REPLACE FUNCTION app_shift_cashup_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'shift_cashup_immutable'
        USING ERRCODE = '23514',
              HINT = 'Record a shift_cashup_adjustments row instead of updating the finalized cash-up.';
END $$;

DROP TRIGGER IF EXISTS shift_cashups_immutable ON shift_cashups;
CREATE TRIGGER shift_cashups_immutable
    BEFORE UPDATE ON shift_cashups
    FOR EACH ROW EXECUTE FUNCTION app_shift_cashup_immutable();

-- ---------------------------------------------------------------------------
-- Cash in / cash out — everything that moves the drawer outside a sale
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_cash_movements (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id  uuid,
    shift_id     uuid NOT NULL,
    direction    text NOT NULL CHECK (direction IN ('in', 'out')),
    amount       bigint NOT NULL CHECK (amount > 0),
    reason       text NOT NULL CHECK (length(btrim(reason)) > 0),
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT shift_cash_movements_shift_business_fk
        FOREIGN KEY (shift_id, business_id)
        REFERENCES employee_shifts (id, business_id)
        ON DELETE CASCADE,
    CONSTRAINT shift_cash_movements_location_business_fk
        FOREIGN KEY (location_id, business_id)
        REFERENCES locations (id, business_id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_shift_cash_movements_shift
    ON shift_cash_movements (shift_id, created_at);

ALTER TABLE shift_cash_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_cash_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shift_cash_movements FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- A movement is a fact about a moment; correcting it means recording the
-- opposite movement with a reason, not editing history.
DROP TRIGGER IF EXISTS shift_cash_movements_immutable ON shift_cash_movements;
CREATE TRIGGER shift_cash_movements_immutable
    BEFORE UPDATE ON shift_cash_movements
    FOR EACH ROW EXECUTE FUNCTION app_shift_cashup_immutable();

-- ---------------------------------------------------------------------------
-- Audited corrections to a finalized cash-up
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_cashup_adjustments (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id    uuid,
    cashup_id      uuid NOT NULL REFERENCES shift_cashups(id) ON DELETE CASCADE,
    shift_id       uuid NOT NULL,
    before_variance bigint,
    after_variance  bigint,
    delta           bigint,
    reason          text NOT NULL CHECK (length(btrim(reason)) > 0),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT shift_cashup_adjustments_location_business_fk
        FOREIGN KEY (location_id, business_id)
        REFERENCES locations (id, business_id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_shift_cashup_adjustments_cashup
    ON shift_cashup_adjustments (cashup_id, created_at);

ALTER TABLE shift_cashup_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_cashup_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shift_cashup_adjustments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

DROP TRIGGER IF EXISTS shift_cashup_adjustments_immutable ON shift_cashup_adjustments;
CREATE TRIGGER shift_cashup_adjustments_immutable
    BEFORE UPDATE ON shift_cashup_adjustments
    FOR EACH ROW EXECUTE FUNCTION app_shift_cashup_immutable();

-- ---------------------------------------------------------------------------
-- Business-day closures: one active closure, reversible history
-- ---------------------------------------------------------------------------
ALTER TABLE business_day_closures
    ADD COLUMN IF NOT EXISTS reopened_at timestamptz,
    ADD COLUMN IF NOT EXISTS reopened_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reopen_note text,
    -- A client-supplied idempotency key, so a retried close (a timeout the
    -- browser retried) finds the closure it already recorded instead of
    -- answering "already closed" for its own row.
    ADD COLUMN IF NOT EXISTS request_id text;

-- A close used to be undone by deleting every row in the scheduled window.
-- History now survives the reopen, and the partial unique index below is what
-- makes two concurrent closes of the same branch-day collide in the database
-- rather than both passing a read-then-insert precheck.
--
-- Rows that predate the column are all "active"; if a branch-day somehow has
-- more than one (possible before this index existed), keep the newest and mark
-- the rest superseded so the index can be created without deleting history.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY location_id, business_date
               ORDER BY closed_at DESC, id DESC
           ) AS position
      FROM business_day_closures
     WHERE reopened_at IS NULL
)
UPDATE business_day_closures c
   SET reopened_at = c.closed_at,
       reopen_note = 'superseded duplicate closure (migration 0233)'
  FROM ranked r
 WHERE c.id = r.id
   AND r.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_day_closures_one_active
    ON business_day_closures (location_id, business_date)
    WHERE reopened_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_business_day_closures_active_recent
    ON business_day_closures (location_id, closed_at DESC)
    WHERE reopened_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_day_closures_request
    ON business_day_closures (location_id, request_id)
    WHERE request_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The shift report prefers the finalized snapshot
-- ---------------------------------------------------------------------------
-- Same columns, same order, same types as 0211 — plus five appended columns
-- (`CREATE OR REPLACE VIEW` may only add at the end). A shift that has been
-- cashed up reports its closing snapshot; a shift with no snapshot (still open,
-- or closed by a path that never counted — offboarding, an old release) keeps
-- the live read, and `cashup_status` says which. The live figures remain
-- available as `restated_*`, so a reviewer can see both without the report
-- silently changing a finalized variance.
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
    coalesce(cu.order_count, sales.order_count, 0)          AS order_count,
    coalesce(cu.gross_total, sales.gross_total, 0)          AS gross_total,
    coalesce(cu.tender_cash, sales.cash_total, 0)           AS cash_total,
    coalesce(cu.tender_card + cu.tender_card_to_card, sales.card_total, 0) AS card_total,
    coalesce(cu.tender_online, sales.online_total, 0)       AS online_total,
    coalesce(cu.tender_credit, sales.credit_total, 0)       AS credit_total,
    -- Finalized variance is authoritative. An unresolved close is NULL — not a
    -- zero variance nobody counted. The fallback only runs when no snapshot
    -- exists (cu.id IS NULL); a finalized row with variance NULL is
    -- meaningful and must not be replaced by a fabricated legacy figure.
    CASE
        WHEN cu.id IS NOT NULL THEN cu.variance
        WHEN s.closing_float IS NULL THEN NULL
        ELSE s.closing_float - (coalesce(s.opening_float, 0) + coalesce(sales.cash_total, 0))
    END                                         AS cash_variance,
    cu.id                                       AS cashup_id,
    coalesce(cu.close_mode, 'live')             AS cashup_status,
    cu.created_at                               AS cashup_at,
    coalesce(sales.cash_total, 0)               AS restated_cash_total,
    CASE
        WHEN s.closing_float IS NULL THEN NULL
        ELSE s.closing_float - (coalesce(s.opening_float, 0) + coalesce(sales.cash_total, 0))
    END                                         AS restated_variance
FROM employee_shifts s
JOIN users u ON u.id = s.employee_id
LEFT JOIN shift_cashups cu ON cu.shift_id = s.id
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
