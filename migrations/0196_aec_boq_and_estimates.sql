-- ============================================================================
-- 0196_aec_boq_and_estimates.sql — issue #799 Wave 4 (§7, "BOQ and estimating").
--
-- The estimating domain the issue describes, built out of the pieces that
-- already exist rather than beside them:
--
--   1. `aec_estimates`         — an estimate OF a project (a BOQ has a title;
--                                a project may price more than one option).
--   2. `aec_estimate_versions` — one frozen-able version of that estimate, with
--                                §7's status model:
--                                draft → submitted → under_review → approved
--                                → superseded.
--   3. `aec_boq_sections`      — the BOQ's chapters («فصل ۳ – کارهای بتنی»),
--                                which is also what the issue's
--                                "discipline/work package" grouping means in a
--                                real BOQ.
--   4. `aec_boq_items`         — the measured rows: code, description, unit,
--                                quantity, the four component rates, waste,
--                                overhead, markup, unit price, total, work
--                                package, an optional supplier/contractor and a
--                                note. Every field of §7's list is a column
--                                here; "rate breakdown" is these four rates, so
--                                it is not a fifth table.
--   5. `aec_estimate_events`   — §7's "approval/history": who moved which
--                                version where, and when.
--
-- THREE RULES THIS FILE EXISTS TO ENFORCE, all of them in the database rather
-- than only in the service:
--
--   * NEVER OVERWRITE AN APPROVED HISTORICAL ESTIMATE. A version freezes the
--     moment it leaves `draft`: its own row stops accepting edits, and so do
--     its sections and items — inserted, updated or deleted. The only write a
--     frozen version accepts is the one transition that must still happen,
--     `approved → superseded`. A service bug (or a hand-run UPDATE) cannot
--     rewrite history here.
--   * THE ESTIMATE'S ARITHMETIC IS THE DATABASE'S. `unit_price_rial` and
--     `total_rial` are computed by a BEFORE trigger from the four rates and the
--     three percentages and are not writable by the caller — so no client, no
--     importer and no future screen can post a row whose total disagrees with
--     its own rate breakdown. `src/lib/aec-boq.ts` mirrors the same formula in
--     exact integer arithmetic for the live preview, and
--     `integration/aec-boq.integration.test.ts` asserts the two agree.
--   * IT IS NOT A SECOND COST LEDGER. Nothing here records what was *spent*.
--     Actual cost stays in Accounting (`journal_entries.project_id`); an
--     approved version only proposes a budget, which Wave 4 writes to
--     `ai_projects.budget_rial` (never over a figure somebody typed by hand —
--     see `aec-boq-service.ts`).
--
-- Tenancy follows 0194 exactly: composite foreign keys to `(business_id, …)`
-- make a cross-tenant reference impossible at the storage layer, a party
-- reference (which cannot use one, because `business_id` is NOT NULL and the
-- constraint needs `ON DELETE SET NULL`) is guarded by a trigger, and every
-- table is FORCE RLS with the standard `tenant_isolation` policy.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The estimate itself
-- ---------------------------------------------------------------------------
-- A container, not a version. The issue lists "estimate" and "estimate version"
-- separately because the same project is routinely priced twice — the base
-- scope and an option, or a client's BOQ and the contractor's — and each of
-- those has its own revision history.
CREATE TABLE aec_estimates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id      uuid NOT NULL,
    title           text NOT NULL CHECK (btrim(title) <> ''),
    note            text NOT NULL DEFAULT '',
    -- Who created the estimate, for display only. A pointer, never a grant.
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by_name text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- Referenced by the children's composite foreign keys.
    UNIQUE (business_id, id),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_estimates_project ON aec_estimates (project_id, created_at DESC);
CREATE INDEX idx_aec_estimates_business ON aec_estimates (business_id);

ALTER TABLE aec_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_estimates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_estimates FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 2. A version of it
-- ---------------------------------------------------------------------------
-- `item_count` and `total_rial` are denormalised on purpose: an approved
-- version's total is the project's working budget, and reading it must not
-- depend on re-summing a table that a later wave might page. They are
-- maintained by `aec_boq_version_totals()` below (never by the caller) and are
-- the only columns a frozen version can still change through the trigger —
-- which cannot happen in practice, because its items are frozen too.
CREATE TABLE aec_estimate_versions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    estimate_id     uuid NOT NULL,
    version_no      integer NOT NULL CHECK (version_no >= 1),
    -- The revision's own label: «بازنگری پس از تغییر نقشههای سازه».
    title           text NOT NULL DEFAULT '',
    status          text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'superseded')),
    item_count      integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
    total_rial      bigint NOT NULL DEFAULT 0 CHECK (total_rial >= 0),
    submitted_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    submitted_at    timestamptz,
    reviewed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     timestamptz,
    approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at     timestamptz,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by_name text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    -- One version number per estimate. The service allocates `max + 1`; this is
    -- what makes two simultaneous "new version" clicks a constraint violation
    -- rather than two rows numbered 3.
    UNIQUE (estimate_id, version_no),
    FOREIGN KEY (business_id, estimate_id)
        REFERENCES aec_estimates (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_estimate_versions_estimate ON aec_estimate_versions (estimate_id, version_no DESC);
CREATE INDEX idx_aec_estimate_versions_approved
    ON aec_estimate_versions (business_id, status) WHERE status = 'approved';

ALTER TABLE aec_estimate_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_estimate_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_estimate_versions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. Sections — the BOQ's chapters
-- ---------------------------------------------------------------------------
CREATE TABLE aec_boq_sections (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    version_id    uuid NOT NULL,
    -- The chapter's own number, as the office writes it («۳» or «03»).
    code          text NOT NULL DEFAULT '',
    title         text NOT NULL CHECK (btrim(title) <> ''),
    display_order integer NOT NULL DEFAULT 0,
    notes         text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- `(business_id, version_id, id)` is what lets an ITEM's composite foreign
    -- key name its section AND its version at once — see §4.
    UNIQUE (business_id, version_id, id),
    FOREIGN KEY (business_id, version_id)
        REFERENCES aec_estimate_versions (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_boq_sections_version ON aec_boq_sections (version_id, display_order);
CREATE INDEX idx_aec_boq_sections_business ON aec_boq_sections (business_id);

ALTER TABLE aec_boq_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_boq_sections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_boq_sections FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 4. The measured rows
-- ---------------------------------------------------------------------------
-- Every field of the issue's list, and the unit of each:
--
--   item/code              → item_code
--   description            → description
--   unit                   → unit
--   quantity               → quantity            numeric(16, 4)
--   material rate          → material_rate_rial  integer rial, per unit
--   labor rate             → labor_rate_rial     integer rial, per unit
--   equipment rate         → equipment_rate_rial integer rial, per unit
--   subcontract rate       → subcontract_rate_rial
--   waste factor           → waste_percent       percent, 0–100
--   overhead               → overhead_percent
--   markup                 → markup_percent
--   unit price             → unit_price_rial     COMPUTED (never sent)
--   total                  → total_rial          COMPUTED (never sent)
--   discipline/work package→ work_package        (chapters do the grouping)
--   optional supplier/contractor → party_id
--   notes                  → notes
--
-- Money is integer rial like every other amount in this schema, and the
-- computed columns are bounded by `Number.MAX_SAFE_INTEGER` — a BOQ total past
-- 9 007 199 254 740 991 rial is not a project, and refusing it here keeps the
-- value exact when it crosses into JavaScript.
--
-- An item with no section is legal (`section_id` null) and lands in a
-- «بدون فصل» bucket: an imported flat BOQ has no chapters until somebody makes
-- them, and refusing to import it would be worse than showing it ungrouped.
-- The composite foreign key `(business_id, version_id, section_id)` is what
-- makes "a section of ANOTHER version" (or another tenant) unrepresentable,
-- and because MATCH SIMPLE skips a key with a NULL column, the null case needs
-- no special handling.
CREATE TABLE aec_boq_items (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    version_id            uuid NOT NULL,
    section_id            uuid,
    display_order         integer NOT NULL DEFAULT 0,
    item_code             text NOT NULL DEFAULT '',
    description           text NOT NULL CHECK (btrim(description) <> ''),
    unit                  text NOT NULL DEFAULT '',
    quantity              numeric(16, 4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    material_rate_rial    bigint NOT NULL DEFAULT 0 CHECK (material_rate_rial >= 0),
    labor_rate_rial       bigint NOT NULL DEFAULT 0 CHECK (labor_rate_rial >= 0),
    equipment_rate_rial   bigint NOT NULL DEFAULT 0 CHECK (equipment_rate_rial >= 0),
    subcontract_rate_rial bigint NOT NULL DEFAULT 0 CHECK (subcontract_rate_rial >= 0),
    waste_percent         numeric(5, 2) NOT NULL DEFAULT 0
        CHECK (waste_percent >= 0 AND waste_percent <= 100),
    overhead_percent      numeric(5, 2) NOT NULL DEFAULT 0
        CHECK (overhead_percent >= 0 AND overhead_percent <= 100),
    markup_percent        numeric(5, 2) NOT NULL DEFAULT 0
        CHECK (markup_percent >= 0 AND markup_percent <= 100),
    -- Computed by the trigger below; the CHECKs are the outer bound that keeps
    -- the arithmetic honest even if the trigger is ever dropped by mistake.
    unit_price_rial       bigint NOT NULL DEFAULT 0
        CHECK (unit_price_rial >= 0 AND unit_price_rial <= 1000000000000000),
    total_rial            bigint NOT NULL DEFAULT 0
        CHECK (total_rial >= 0 AND total_rial <= 9007199254740991),
    work_package          text NOT NULL DEFAULT '',
    -- The supplier or subcontractor priced against this line, when one was
    -- named. A single-column FK (see the note in 0194): `business_id` is NOT
    -- NULL, so a composite key could not carry `ON DELETE SET NULL`.
    party_id              uuid REFERENCES parties(id) ON DELETE SET NULL,
    notes                 text NOT NULL DEFAULT '',
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (business_id, version_id)
        REFERENCES aec_estimate_versions (business_id, id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, version_id, section_id)
        REFERENCES aec_boq_sections (business_id, version_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_boq_items_version ON aec_boq_items (version_id, display_order);
CREATE INDEX idx_aec_boq_items_section ON aec_boq_items (section_id, display_order);
CREATE INDEX idx_aec_boq_items_party ON aec_boq_items (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX idx_aec_boq_items_business ON aec_boq_items (business_id);

ALTER TABLE aec_boq_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_boq_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_boq_items FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 5. Approval and revision history
-- ---------------------------------------------------------------------------
-- §7's "estimate approval/history". One row per life-cycle action — created,
-- submitted, review started, approved, returned, superseded, imported — not
-- one per line edit: a history that records every keystroke is a log, and what
-- a reviewer of a construction estimate actually asks is "who approved this
-- revision, and what did it replace".
CREATE TABLE aec_estimate_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id   uuid NOT NULL,
    estimate_id  uuid NOT NULL,
    -- Null only for the estimate's own creation, which precedes any version.
    version_id   uuid,
    action       text NOT NULL CHECK (action IN (
        'created', 'version_created', 'updated', 'submitted', 'review_started',
        'approved', 'returned', 'superseded', 'imported', 'deleted'
    )),
    summary      text NOT NULL DEFAULT '',
    actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_name   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, estimate_id)
        REFERENCES aec_estimates (business_id, id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, version_id)
        REFERENCES aec_estimate_versions (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_estimate_events_estimate
    ON aec_estimate_events (estimate_id, created_at DESC);
CREATE INDEX idx_aec_estimate_events_project
    ON aec_estimate_events (project_id, created_at DESC);
CREATE INDEX idx_aec_estimate_events_business
    ON aec_estimate_events (business_id, created_at DESC);

ALTER TABLE aec_estimate_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_estimate_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_estimate_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 6. The arithmetic — the database owns it
-- ---------------------------------------------------------------------------
-- The combined formula, in one expression with no intermediate rounding:
--
--   unit_price = round( (material + labor + equipment + subcontract)
--                       × (1 + waste%) × (1 + overhead%) × (1 + markup%) )
--   total      = round( quantity × unit_price )
--
-- The percentages enter as integer basis points (1% = 100 bp), so the whole
-- calculation is exact decimal arithmetic — no float ever participates, in
-- PostgreSQL or in the TypeScript mirror. `round(numeric)` is half-up for the
-- non-negative values these columns allow, which is exactly what the mirror's
-- `(numerator + half) / denominator` does with integers.
CREATE OR REPLACE FUNCTION aec_boq_item_totals() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    rate_sum numeric;
    unit_price numeric;
    total numeric;
BEGIN
    rate_sum := NEW.material_rate_rial + NEW.labor_rate_rial
                + NEW.equipment_rate_rial + NEW.subcontract_rate_rial;

    unit_price := round(
        rate_sum
        * (10000 + round(NEW.waste_percent * 100))
        * (10000 + round(NEW.overhead_percent * 100))
        * (10000 + round(NEW.markup_percent * 100))
        / 1000000000000
    );
    total := round(NEW.quantity * unit_price);

    IF unit_price > 1000000000000000 THEN
        RAISE EXCEPTION 'aec_boq_items: unit price out of range'
            USING ERRCODE = 'check_violation';
    END IF;
    IF total > 9007199254740991 THEN
        RAISE EXCEPTION 'aec_boq_items: line total out of range'
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.unit_price_rial := unit_price;
    NEW.total_rial := total;
    RETURN NEW;
END $$;

-- BEFORE: the caller's numbers are overwritten, not validated, so a stale
-- client can never write a total that disagrees with the line's own rates.
CREATE TRIGGER trg_aec_boq_items_totals
    BEFORE INSERT OR UPDATE ON aec_boq_items
    FOR EACH ROW EXECUTE FUNCTION aec_boq_item_totals();

-- AFTER: the version's denormalised totals follow its lines. The recursion is
-- bounded — this updates `aec_estimate_versions`, which has no trigger that
-- writes items back.
CREATE OR REPLACE FUNCTION aec_boq_version_totals() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target uuid;
BEGIN
    target := COALESCE(NEW.version_id, OLD.version_id);
    UPDATE aec_estimate_versions v
       SET item_count = (SELECT count(*) FROM aec_boq_items i WHERE i.version_id = target),
           total_rial = (SELECT COALESCE(sum(i.total_rial), 0) FROM aec_boq_items i WHERE i.version_id = target),
           updated_at = now()
     WHERE v.id = target;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_aec_boq_items_version_totals
    AFTER INSERT OR UPDATE OR DELETE ON aec_boq_items
    FOR EACH ROW EXECUTE FUNCTION aec_boq_version_totals();

-- ---------------------------------------------------------------------------
-- 7. The immutability guard — "never overwrite an approved historical estimate"
-- ---------------------------------------------------------------------------
-- Two triggers, one rule. A version is editable only while it is `draft`:
--
--   * `aec_estimate_version_guard` freezes the version ROW the moment it
--     leaves draft (identity, numbering and totals become unchangeable, and
--     only `approved → superseded` is accepted as a status change), and
--     refuses deletion of anything but a draft;
--   * `aec_boq_line_guard` refuses INSERT, UPDATE and DELETE of sections and
--     items whose version is not a draft — so returning to a draft is the only
--     way to change numbers, and a draft is by definition not yet approved.
--
-- Both raise `check_violation`, so a hand-run SQL statement and a buggy service
-- fail the same way, with the same message.
CREATE OR REPLACE FUNCTION aec_estimate_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    allowed boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'aec_estimate_versions: only a draft version can be deleted'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        allowed := (OLD.status = 'draft'         AND NEW.status = 'submitted')
                OR (OLD.status = 'submitted'     AND NEW.status = 'under_review')
                OR (OLD.status = 'submitted'     AND NEW.status = 'approved')
                OR (OLD.status = 'submitted'     AND NEW.status = 'draft')
                OR (OLD.status = 'under_review'  AND NEW.status = 'approved')
                OR (OLD.status = 'under_review'  AND NEW.status = 'draft')
                OR (OLD.status = 'approved'      AND NEW.status = 'superseded');
        IF NOT allowed THEN
            RAISE EXCEPTION 'aec_estimate_versions: illegal status transition % -> %',
                OLD.status, NEW.status USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF OLD.status IN ('approved', 'superseded') THEN
        IF NEW.id <> OLD.id
           OR NEW.business_id <> OLD.business_id
           OR NEW.estimate_id <> OLD.estimate_id
           OR NEW.version_no <> OLD.version_no
           OR NEW.title <> OLD.title
           OR NEW.item_count <> OLD.item_count
           OR NEW.total_rial <> OLD.total_rial THEN
            RAISE EXCEPTION 'aec_estimate_versions: an approved revision is a historical record'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_estimate_versions_guard
    BEFORE UPDATE OR DELETE ON aec_estimate_versions
    FOR EACH ROW EXECUTE FUNCTION aec_estimate_version_guard();

-- ---------------------------------------------------------------------------
-- 8. The same guard for the lines
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION aec_boq_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    version uuid;
    version_status text;
BEGIN
    version := COALESCE(NEW.version_id, OLD.version_id);
    SELECT status INTO version_status FROM aec_estimate_versions WHERE id = version;
    IF version_status IS NULL THEN
        RAISE EXCEPTION 'aec_boq: version % does not exist', version
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF version_status <> 'draft' THEN
        RAISE EXCEPTION 'aec_boq: revision % is % and can no longer be edited',
            version, version_status USING ERRCODE = 'check_violation';
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_aec_boq_sections_guard
    BEFORE INSERT OR UPDATE OR DELETE ON aec_boq_sections
    FOR EACH ROW EXECUTE FUNCTION aec_boq_line_guard();

CREATE TRIGGER trg_aec_boq_items_guard
    BEFORE INSERT OR UPDATE OR DELETE ON aec_boq_items
    FOR EACH ROW EXECUTE FUNCTION aec_boq_line_guard();

-- ---------------------------------------------------------------------------
-- 9. The party reference, tenant-checked
-- ---------------------------------------------------------------------------
-- The same shape as 0194's participant guard, for the line's optional
-- supplier/contractor: a live party of the same business, or nothing.
CREATE OR REPLACE FUNCTION aec_assert_boq_party_tenant_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.party_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM parties
                        WHERE id = NEW.party_id
                          AND business_id = NEW.business_id
                          AND merged_into_id IS NULL) THEN
        RAISE EXCEPTION 'aec_boq_items.party_id must reference a live party of the same business'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_boq_items_tenant_refs
    BEFORE INSERT OR UPDATE OF business_id, party_id ON aec_boq_items
    FOR EACH ROW EXECUTE FUNCTION aec_assert_boq_party_tenant_owned();

-- ---------------------------------------------------------------------------
-- 10. An estimate version is an approvable subject
-- ---------------------------------------------------------------------------
-- §7's approval step reuses the workspace's approval engine rather than
-- inventing a second one: submitting a version files a `workspace_approvals`
-- row (so it appears in «تأییدها», in the dashboard counters and in the
-- approval widgets), deciding that row moves the version, and the decision is
-- gated by `workspace.approve` — which is §24's rule that a commercial action
-- must not inherit ordinary task-edit rights.
--
-- Widening the CHECK is additive and idempotent: the new list is a superset of
-- the old one, so a schema where the constraint is named differently keeps both
-- and neither refuses an existing row.
ALTER TABLE workspace_approvals DROP CONSTRAINT IF EXISTS workspace_approvals_subject_type_check;
ALTER TABLE workspace_approvals ADD CONSTRAINT workspace_approvals_subject_type_check
    CHECK (subject_type IN ('project', 'task', 'document', 'contract', 'estimate_version'));

-- The activity feed carries the estimate's life-cycle events too, so the
-- project page's «فعالیت اخیر» strip shows a revision being approved next to
-- the tasks that moved the same day.
ALTER TABLE workspace_activity DROP CONSTRAINT IF EXISTS workspace_activity_subject_type_check;
ALTER TABLE workspace_activity ADD CONSTRAINT workspace_activity_subject_type_check
    CHECK (subject_type IN (
        'project', 'task', 'document', 'contract', 'approval', 'member', 'event',
        'estimate'
    ));
