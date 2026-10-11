-- Issue #834 — permission-aware fiscal controls, adopted coverage, and
-- immutable journal lines for closed periods.
--
-- The original trigger preserved legacy behavior by letting every uncovered
-- date post. Keep already-recorded pre-adoption journal rows compatible, but
-- once a business creates its first fiscal year require every new posting to
-- be explicitly covered, including back-dated entries. Soft-close permission is supplied by the canonical
-- request authorization snapshot through app GUCs; role names are never
-- re-derived in SQL. Only the existing transaction-scoped factory-reset
-- escape hatch may intentionally tear down closed-period data.

ALTER TABLE businesses
  ADD COLUMN fiscal_control_required_from date,
  ADD COLUMN fiscal_control_adopted_at timestamptz;

COMMENT ON COLUMN businesses.fiscal_control_required_from IS
  'Business date fiscal controls were adopted; retained for operator/audit context.';
COMMENT ON COLUMN businesses.fiscal_control_adopted_at IS
  'Instant from which newly inserted journal entries must belong to a defined fiscal period; rows posted before this instant remain legacy-compatible.';

-- Businesses that were already using fiscal years when this migration rolls
-- out have adopted the control. Backfill the control instant after all existing
-- journal rows were recorded, preserving those rows while closing the write
-- hole for every subsequent post.
UPDATE businesses b
   SET fiscal_control_required_from = CURRENT_DATE,
       fiscal_control_adopted_at = clock_timestamp()
 WHERE EXISTS (
   SELECT 1 FROM fiscal_years fy WHERE fy.business_id = b.id
 );

CREATE OR REPLACE FUNCTION adopt_fiscal_period_controls() RETURNS trigger AS $$
BEGIN
  UPDATE businesses
     SET fiscal_control_required_from = COALESCE(fiscal_control_required_from, CURRENT_DATE),
         fiscal_control_adopted_at = COALESCE(fiscal_control_adopted_at, clock_timestamp())
   WHERE id = NEW.business_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_adopt_fiscal_period_controls
  AFTER INSERT ON fiscal_years
  FOR EACH ROW EXECUTE FUNCTION adopt_fiscal_period_controls();

-- This helper validates a permission snapshot produced by authorize.ts. The
-- connection checkout stamps the actor only when the canonical, live
-- membership belongs to the tenant scope and holds ledger.close_period. The
-- existing transaction-scoped factory-reset escape hatch remains available
-- for explicit platform-level tenant teardown, never ordinary application writes.
CREATE OR REPLACE FUNCTION fiscal_actor_authorized_for_close(
  target_business_id uuid,
  target_actor_id uuid
) RETURNS boolean AS $$
DECLARE
  scoped_business_id text := NULLIF(current_setting('app.business_id', true), '');
  scoped_actor_id text := NULLIF(current_setting('app.fiscal_actor_id', true), '');
BEGIN
  IF current_setting('app.fiscal_close_period', true) IS DISTINCT FROM 'on'
     OR scoped_business_id IS DISTINCT FROM target_business_id::text
     OR scoped_actor_id IS DISTINCT FROM target_actor_id::text THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM users u
      JOIN businesses b ON b.id = u.business_id
     WHERE u.id = target_actor_id
       AND u.business_id = target_business_id
       AND u.is_active
       AND COALESCE(u.membership_status::text, 'active') = 'active'
       AND b.status::text = 'active'
  );
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION enforce_fiscal_period_lock() RETURNS trigger AS $$
DECLARE
  period_status fiscal_period_status;
  old_period_status fiscal_period_status;
  controls_adopted_at timestamptz;
  old_controls_adopted_at timestamptz;
BEGIN
  IF app_factory_reset_active() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- Child entries are removed only as part of a tenant/parent cascade. Direct
  -- deletes are still checked below, and a direct parent deletion is guarded
  -- by trg_enforce_fiscal_period_entry_delete before the cascade can start.
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;

    SELECT status INTO old_period_status
      FROM fiscal_periods
     WHERE business_id = OLD.business_id
       AND OLD.entry_date BETWEEN starts_on AND ends_on
     LIMIT 1
     FOR SHARE;
    SELECT fiscal_control_adopted_at INTO old_controls_adopted_at
      FROM businesses WHERE id = OLD.business_id;

    IF old_period_status = 'locked' THEN
      RAISE EXCEPTION 'fiscal_period_locked' USING ERRCODE = 'P0001';
    END IF;
    IF old_period_status = 'soft_closed' THEN
      RAISE EXCEPTION 'fiscal_period_soft_closed' USING ERRCODE = 'P0001';
    END IF;
    IF old_period_status IS NULL AND old_controls_adopted_at IS NOT NULL AND OLD.posted_at >= old_controls_adopted_at THEN
      RAISE EXCEPTION 'fiscal_period_not_defined' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  -- Retiming or changing the creator of an existing entry in a closed period
  -- would rewrite the history protected by that close. Reversals remain new
  -- append-only journal entries and are unaffected.
  IF TG_OP = 'UPDATE' THEN
    SELECT status INTO old_period_status
      FROM fiscal_periods
     WHERE business_id = OLD.business_id
       AND OLD.entry_date BETWEEN starts_on AND ends_on
     LIMIT 1
     FOR SHARE;
    SELECT fiscal_control_adopted_at INTO old_controls_adopted_at
      FROM businesses WHERE id = OLD.business_id;

    IF old_period_status = 'locked' THEN
      RAISE EXCEPTION 'fiscal_period_locked' USING ERRCODE = 'P0001';
    END IF;
    IF old_period_status = 'soft_closed' THEN
      RAISE EXCEPTION 'fiscal_period_soft_closed' USING ERRCODE = 'P0001';
    END IF;
    IF old_period_status IS NULL AND old_controls_adopted_at IS NOT NULL AND OLD.posted_at >= old_controls_adopted_at THEN
      RAISE EXCEPTION 'fiscal_period_not_defined' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT status INTO period_status
    FROM fiscal_periods
   WHERE business_id = NEW.business_id
     AND NEW.entry_date BETWEEN starts_on AND ends_on
   LIMIT 1
   FOR SHARE;
  SELECT fiscal_control_adopted_at INTO controls_adopted_at
    FROM businesses WHERE id = NEW.business_id;

  IF period_status IS NULL THEN
    IF controls_adopted_at IS NOT NULL AND clock_timestamp() >= controls_adopted_at THEN
      RAISE EXCEPTION 'fiscal_period_not_defined' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF period_status = 'locked' THEN
    RAISE EXCEPTION 'fiscal_period_locked' USING ERRCODE = 'P0001';
  END IF;

  IF period_status = 'soft_closed' THEN
    -- Existing entries cannot be moved into a soft-closed period; only a new
    -- journal entry may be constructed there, by the live authorized actor.
    IF TG_OP <> 'INSERT'
       OR NEW.created_by IS NULL
       OR NOT fiscal_actor_authorized_for_close(NEW.business_id, NEW.created_by) THEN
      RAISE EXCEPTION 'fiscal_period_soft_closed' USING ERRCODE = 'P0001';
    END IF;

    -- The child-line guard accepts inserts only for this freshly inserted
    -- parent and only in this transaction. A conflicting import retry gets a
    -- different generated id and can never reuse this construction marker for
    -- an existing journal entry.
    PERFORM set_config('app.fiscal_constructing_entry_id', NEW.id::text, true);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Preserve the existing insert/date/creator guard and add deletion protection.
DROP TRIGGER trg_enforce_fiscal_period_lock ON journal_entries;
CREATE TRIGGER trg_enforce_fiscal_period_lock
  BEFORE INSERT OR UPDATE OF business_id, entry_date, created_by
  ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_fiscal_period_lock();

CREATE TRIGGER trg_enforce_fiscal_period_entry_delete
  BEFORE DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_fiscal_period_lock();

CREATE OR REPLACE FUNCTION enforce_fiscal_journal_line_integrity() RETURNS trigger AS $$
DECLARE
  old_business_id uuid;
  old_entry_date date;
  old_posted_at timestamptz;
  old_status fiscal_period_status;
  old_controls_adopted_at timestamptz;
  new_business_id uuid;
  new_entry_date date;
  new_posted_at timestamptz;
  new_created_by uuid;
  new_status fiscal_period_status;
  new_controls_adopted_at timestamptz;
  constructing_entry_id text := NULLIF(current_setting('app.fiscal_constructing_entry_id', true), '');
BEGIN
  IF app_factory_reset_active() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT je.business_id, je.entry_date, je.posted_at
      INTO old_business_id, old_entry_date, old_posted_at
      FROM journal_entries je
     WHERE je.id = OLD.entry_id;

    -- The parent is already gone only during an FK cascade. A direct
    -- standalone child delete cannot reach this branch because entry_id is
    -- non-null and references an existing journal entry.
    IF NOT FOUND THEN
      IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
      RETURN OLD;
    END IF;

    SELECT status INTO old_status
      FROM fiscal_periods
     WHERE business_id = old_business_id
       AND old_entry_date BETWEEN starts_on AND ends_on
     LIMIT 1
     FOR SHARE;
    SELECT fiscal_control_adopted_at INTO old_controls_adopted_at
      FROM businesses WHERE id = old_business_id;

    IF old_status = 'locked' THEN
      RAISE EXCEPTION 'fiscal_period_locked' USING ERRCODE = 'P0001';
    END IF;
    IF old_status = 'soft_closed' THEN
      RAISE EXCEPTION 'fiscal_period_soft_closed' USING ERRCODE = 'P0001';
    END IF;
    IF old_status IS NULL AND old_controls_adopted_at IS NOT NULL AND old_posted_at >= old_controls_adopted_at THEN
      RAISE EXCEPTION 'fiscal_period_not_defined' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT je.business_id, je.entry_date, je.created_by, je.posted_at
      INTO new_business_id, new_entry_date, new_created_by, new_posted_at
      FROM journal_entries je
     WHERE je.id = NEW.entry_id;
    IF NOT FOUND THEN RETURN NEW; END IF;

    SELECT status INTO new_status
      FROM fiscal_periods
     WHERE business_id = new_business_id
       AND new_entry_date BETWEEN starts_on AND ends_on
     LIMIT 1
     FOR SHARE;
    SELECT fiscal_control_adopted_at INTO new_controls_adopted_at
      FROM businesses WHERE id = new_business_id;

    IF new_status IS NULL AND new_controls_adopted_at IS NOT NULL AND new_posted_at >= new_controls_adopted_at THEN
      RAISE EXCEPTION 'fiscal_period_not_defined' USING ERRCODE = 'P0001';
    END IF;
    IF new_status = 'locked' THEN
      RAISE EXCEPTION 'fiscal_period_locked' USING ERRCODE = 'P0001';
    END IF;
    IF new_status = 'soft_closed' THEN
      IF TG_OP = 'INSERT'
         AND constructing_entry_id = NEW.entry_id::text
         AND new_created_by IS NOT NULL
         AND fiscal_actor_authorized_for_close(new_business_id, new_created_by) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'fiscal_period_soft_closed' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_fiscal_journal_line_integrity
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_fiscal_journal_line_integrity();


-- Fiscal lifecycle evidence is an append-only stream. Keep the platform's
-- explicit, transaction-scoped factory reset able to remove the operational
-- audit rows along with the tenant, while rejecting normal updates/deletes.
CREATE OR REPLACE FUNCTION protect_fiscal_lifecycle_audit() RETURNS trigger AS $$
BEGIN
  IF app_factory_reset_active() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- Tenant cascades remove their audit subtree as one approved destructive
  -- operation; ordinary direct mutation of fiscal evidence is forbidden.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.entity IN ('fiscal_year', 'fiscal_period')
       AND OLD.action IN (
         'fiscal_year.created',
         'fiscal_period.soft_closed',
         'fiscal_period.locked',
         'fiscal_period.reopened',
         'fiscal_year.closed'
       ) THEN
      RAISE EXCEPTION 'fiscal_audit_append_only' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF (OLD.entity IN ('fiscal_year', 'fiscal_period')
       AND OLD.action IN (
         'fiscal_year.created',
         'fiscal_period.soft_closed',
         'fiscal_period.locked',
         'fiscal_period.reopened',
         'fiscal_year.closed'
       ))
     OR (NEW.entity IN ('fiscal_year', 'fiscal_period')
       AND NEW.action IN (
         'fiscal_year.created',
         'fiscal_period.soft_closed',
         'fiscal_period.locked',
         'fiscal_period.reopened',
         'fiscal_year.closed'
       )) THEN
    RAISE EXCEPTION 'fiscal_audit_append_only' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_fiscal_lifecycle_audit
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION protect_fiscal_lifecycle_audit();
