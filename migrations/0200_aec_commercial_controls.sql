-- ============================================================================
-- 0200_aec_commercial_controls.sql — issue #799 Wave 8 (§15 variations and
-- change orders, §16 progress measurement and payment certificates, §17 the AEC
-- fields on an execution contract, §20 the project's commercial cockpit).
--
-- §15 and §16 describe two of the most consequential records in a construction
-- business — what the client agreed to pay for a change, and what has been
-- certified for payment — and §20 asks for one screen that adds them up. Five
-- tables:
--
--   1. `aec_contract_commercials`           — §17's AEC block on an execution
--                                             contract (advance, retention,
--                                             guarantees, insurance, the
--                                             responsible manager) plus the
--                                             materialised revised value
--   2. `aec_variations`                     — §15's change orders, one row per
--                                             change, numbered per project
--   3. `aec_commercial_events`              — §33's immutable trail for both
--                                             the variation and the certificate
--   4. `aec_payment_certificates`           — §16's periodic claim: measured,
--                                             deducted, certified
--   5. `aec_payment_certificate_lines`      — what the claim was measured
--                                             against (§16's "linked BOQ/work
--                                             packages")
--
-- SIX RULES THIS FILE EXISTS TO ENFORCE, all in the database rather than only in
-- the service:
--
--   * AN APPROVED VARIATION MOVES THE CONTRACT VALUE, IT NEVER REWRITES THE
--     CONTRACT. §15 is explicit: "must not rewrite the original contract
--     amount, the original approved BOQ, old estimate versions". So the original
--     stays on `workspace_contracts.value_rial` and reading it is unchanged;
--     `aec_contract_commercials.revised_value_rial` is recomputed from the
--     contract plus its approved variations by a trigger, on every write that
--     could change either side. A number three screens read is not left to three
--     call sites to keep in step.
--   * A SUBMITTED CHANGE ORDER IS FROZEN. From `submitted` on, the fields the
--     client received — description, source, the four amounts, the linked RFI —
--     accept no change; the status chain still moves, and a rejected order can
--     be re-priced (which re-opens it deliberately, through the chain).
--   * A CERTIFIED CLAIM IS HISTORY. §33 asks for "payment certificate
--     approval" in the immutable trail; the row itself carries the arithmetic,
--     so once certified neither its figures nor its lines may move.
--   * THE ARITHMETIC IS THE DATABASE'S. Net = gross − advance recovery −
--     retention − other deductions − tax, as a CHECK; the lines, when there are
--     any, must add up to the gross figure the moment the claim leaves draft.
--     `certificateTotals` in `src/lib/aec-commercial.ts` is the same expression,
--     which is why a live preview and a stored row agree.
--   * AN ADVANCE CANNOT OVER-RECOVER. A recovery larger than the advance booked
--     on the contract is refused, and so is a retention figure that is not
--     plausible against the claim — the size of the mistake matters more here
--     than in any other register in this module.
--   * THE FILES ARE THE PLATFORM'S FILES, again: a variation's supporting
--     documents and a claim's measurement sheets are `workspace_documents` rows
--     linked by two new nullable columns, through the same trigger 0198 and 0199
--     extended.
--
-- Tenancy and immutability follow 0194/0196/0197/0198/0199 exactly: composite
-- foreign keys to `(business_id, …)`, triggers for the references that cannot
-- use one (users, parties, a nullable contract), and FORCE RLS with the standard
-- `tenant_isolation` policy on every table.
--
-- Known follow-up (Wave 11), same as 0196–0199: a certified claim and an
-- approved variation cannot be deleted, so a project teardown that cascades
-- through one is refused by these guards. Projects are archived rather than
-- deleted today.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. What the new tables need from the tables that already exist
-- ---------------------------------------------------------------------------
-- A composite foreign key needs a unique key to point at. `workspace_contracts`
-- has never had one on `(business_id, id)` — the commercial block is the first
-- row whose tenancy is only provable through the contract, so it gets one here.
ALTER TABLE workspace_contracts
    ADD CONSTRAINT workspace_contracts_business_id_id_key UNIQUE (business_id, id);

-- ---------------------------------------------------------------------------
-- 1. §17 — the AEC fields on an execution contract
-- ---------------------------------------------------------------------------
CREATE TABLE aec_contract_commercials (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    contract_id            uuid NOT NULL,
    -- §17's own list, minus what the contract already carries: its number, its
    -- scope, its start and end dates, its counterparty and its *original* value
    -- all stay on `workspace_contracts` (0167). Duplicating them here is how a
    -- "revised" figure quietly becomes a second original.
    contract_number        text NOT NULL DEFAULT '',
    scope                  text NOT NULL DEFAULT '',
    -- The revised contractual value: original + approved variations. Written by
    -- the trigger below, never by a caller — a client that could set this by
    -- hand could hide an approved variation.
    revised_value_rial     bigint CHECK (revised_value_rial IS NULL OR revised_value_rial >= 0),
    advance_percent        numeric(5, 2) CHECK (advance_percent IS NULL OR advance_percent BETWEEN 0 AND 100),
    advance_amount_rial    bigint CHECK (advance_amount_rial IS NULL OR advance_amount_rial >= 0),
    retention_percent      numeric(5, 2) CHECK (retention_percent IS NULL OR retention_percent BETWEEN 0 AND 100),
    payment_terms          text NOT NULL DEFAULT '',
    -- §17's "defects-liability period": months after handover during which the
    -- contractor must return and fix. A number, because the release date is a
    -- read (handover date + months), not a stored deadline to go stale.
    defects_liability_months integer
        CHECK (defects_liability_months IS NULL OR defects_liability_months BETWEEN 0 AND 240),
    -- §22's and §29's "guarantee/bond expiry": the guarantee the contract is
    -- secured with, and when it lapses. Both dates are what the reminder scan
    -- and the cockpit read.
    guarantee_type         text NOT NULL DEFAULT '',
    guarantee_reference    text NOT NULL DEFAULT '',
    guarantee_amount_rial  bigint CHECK (guarantee_amount_rial IS NULL OR guarantee_amount_rial >= 0),
    guarantee_expiry       date,
    insurance_reference    text NOT NULL DEFAULT '',
    insurance_expiry       date,
    -- §17's "responsible manager". A pointer for display, never a grant.
    responsible_user_id    uuid,
    responsible_name       text NOT NULL DEFAULT '',
    created_by             uuid,
    created_by_name        text NOT NULL DEFAULT '',
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    -- One commercial block per contract: it is an extension of the row, not a
    -- history of revisions. An amended contract amends this block.
    UNIQUE (contract_id),
    FOREIGN KEY (business_id, contract_id)
        REFERENCES workspace_contracts (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_contract_commercials_business
    ON aec_contract_commercials (business_id);
CREATE INDEX idx_aec_contract_commercials_guarantee
    ON aec_contract_commercials (business_id, guarantee_expiry)
    WHERE guarantee_expiry IS NOT NULL;

ALTER TABLE aec_contract_commercials ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_contract_commercials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_contract_commercials FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 2. §15 — variations and change orders
-- ---------------------------------------------------------------------------
CREATE TABLE aec_variations (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id          uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id           uuid NOT NULL,
    -- Optional: a change can be raised (and priced) before the execution
    -- contract it will amend is signed. It is the contract's revised value that
    -- stays empty until there is a contract, never the change that is lost.
    contract_id          uuid REFERENCES workspace_contracts(id) ON DELETE SET NULL,
    variation_number     text NOT NULL CHECK (btrim(variation_number) <> ''),
    source               text NOT NULL DEFAULT 'other'
                             CHECK (source IN (
                                 'client_instruction', 'design_change', 'site_condition',
                                 'regulatory', 'omission_correction', 'other'
                             )),
    reason               text NOT NULL DEFAULT '',
    description          text NOT NULL CHECK (btrim(description) <> ''),
    -- Four nullable pointers, each with a plain foreign key for *existence* and
    -- the tenant trigger in section 7 for *ownership*: a composite key would
    -- need `ON DELETE SET NULL` and would null `business_id` with it.
    responsible_party_id uuid REFERENCES parties(id) ON DELETE RESTRICT,
    -- §15's "linked RFI". Wave 6 deliberately left this column to the wave that
    -- owns the variation: the later record points at the earlier one, so an RFI
    -- does not have to grow a column for a table that did not exist yet.
    rfi_id               uuid REFERENCES aec_rfis(id) ON DELETE SET NULL,
    -- §15's four money figures, in the issue's own words: the internal estimate,
    -- what the change costs to execute, what was claimed from the client and what
    -- the client agreed. They are allowed to differ — that difference *is* the
    -- commercial story of a change order.
    estimated_amount_rial bigint CHECK (estimated_amount_rial IS NULL OR estimated_amount_rial >= 0),
    cost_impact_rial     bigint CHECK (cost_impact_rial IS NULL OR cost_impact_rial >= 0),
    submitted_amount_rial bigint CHECK (submitted_amount_rial IS NULL OR submitted_amount_rial >= 0),
    approved_amount_rial bigint CHECK (approved_amount_rial IS NULL OR approved_amount_rial >= 0),
    -- Days added to the programme (§15's "schedule impact"). Negative is
    -- deliberate: an acceleration or an omitted activity shortens the programme,
    -- and refusing to record it would push it into a note.
    schedule_impact_days integer,
    status               text NOT NULL DEFAULT 'draft'
                             CHECK (status IN (
                                 'draft', 'priced', 'submitted', 'under_review',
                                 'approved', 'rejected', 'implemented', 'cancelled'
                             )),
    submitted_date       date,
    approved_date        date,
    implemented_date     date,
    created_by           uuid,
    created_by_name      text NOT NULL DEFAULT '',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    -- The chain's own preconditions, as data rules rather than UI hints: a
    -- "priced" order with no price, a submitted one with no claim, an approved
    -- one with no agreed figure or an implemented one with no date would each be
    -- a screen that lies.
    CHECK (status <> 'priced' OR estimated_amount_rial IS NOT NULL),
    CHECK (status NOT IN ('submitted', 'under_review', 'approved', 'rejected', 'implemented')
           OR submitted_amount_rial IS NOT NULL),
    CHECK (status NOT IN ('approved', 'implemented') OR approved_amount_rial IS NOT NULL),
    CHECK (status NOT IN ('approved', 'implemented') OR approved_date IS NOT NULL),
    CHECK (status <> 'implemented' OR implemented_date IS NOT NULL),
    -- One number per project, however many people raise changes.
    UNIQUE (business_id, project_id, variation_number),
    -- What the trail's composite key points at (0196–0199's convention).
    UNIQUE (business_id, id),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_variations_project
    ON aec_variations (project_id, variation_number);
CREATE INDEX idx_aec_variations_business
    ON aec_variations (business_id, status);
CREATE INDEX idx_aec_variations_contract
    ON aec_variations (contract_id) WHERE contract_id IS NOT NULL;
CREATE INDEX idx_aec_variations_rfi
    ON aec_variations (rfi_id) WHERE rfi_id IS NOT NULL;
CREATE INDEX idx_aec_variations_party
    ON aec_variations (responsible_party_id) WHERE responsible_party_id IS NOT NULL;

ALTER TABLE aec_variations ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_variations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_variations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. §16 — the payment certificate
-- ---------------------------------------------------------------------------
CREATE TABLE aec_payment_certificates (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id            uuid NOT NULL,
    contract_id           uuid REFERENCES workspace_contracts(id) ON DELETE SET NULL,
    certificate_number    text NOT NULL CHECK (btrim(certificate_number) <> ''),
    -- §16's two directions: our claim to the client, or the certificate we
    -- issue to a contractor. Same arithmetic, opposite side of the table.
    kind                  text NOT NULL DEFAULT 'application'
                              CHECK (kind IN ('application', 'certificate')),
    period_start          date NOT NULL,
    period_end            date NOT NULL,
    -- §16's "progress %" — the physical progress this claim is measured at.
    progress_percent       numeric(5, 2)
                              CHECK (progress_percent IS NULL OR progress_percent BETWEEN 0 AND 100),
    -- §16's money, in the order the issue lists it. "Work completed" is the
    -- gross; "current certified" is `net_rial`; "previous certified" is derived
    -- from the contract's earlier certified claims by the service, never stored
    -- (two places holding one running total is how one of them goes stale).
    gross_rial            bigint NOT NULL DEFAULT 0 CHECK (gross_rial >= 0),
    advance_recovery_rial bigint NOT NULL DEFAULT 0 CHECK (advance_recovery_rial >= 0),
    retention_rial        bigint NOT NULL DEFAULT 0 CHECK (retention_rial >= 0),
    other_deductions_rial bigint NOT NULL DEFAULT 0 CHECK (other_deductions_rial >= 0),
    tax_rial              bigint NOT NULL DEFAULT 0 CHECK (tax_rial >= 0),
    net_rial              bigint NOT NULL DEFAULT 0 CHECK (net_rial >= 0),
    -- §16's "approved amount": what the certifier actually approved. Usually the
    -- net, occasionally less — never more, which is the mistake that matters.
    approved_amount_rial  bigint CHECK (approved_amount_rial IS NULL OR approved_amount_rial >= 0),
    status                text NOT NULL DEFAULT 'draft'
                              CHECK (status IN (
                                  'draft', 'submitted', 'under_review',
                                  'certified', 'rejected', 'cancelled'
                              )),
    submitted_date        date,
    certified_date        date,
    created_by            uuid,
    created_by_name       text NOT NULL DEFAULT '',
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CHECK (period_end >= period_start),
    -- §16's arithmetic, stated once: what is claimed is the measured work less
    -- every deduction. `certificateTotals` in src/lib/aec-commercial.ts is the
    -- same expression, which is why the form's preview cannot disagree with the
    -- stored row.
    CHECK (net_rial = gross_rial - advance_recovery_rial - retention_rial
                       - other_deductions_rial - tax_rial),
    CHECK (status <> 'certified' OR approved_amount_rial IS NOT NULL),
    CHECK (status <> 'certified' OR certified_date IS NOT NULL),
    -- An approval may reduce a claim but not inflate it.
    CHECK (approved_amount_rial IS NULL OR approved_amount_rial <= net_rial),
    UNIQUE (business_id, project_id, certificate_number),
    UNIQUE (business_id, id),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_payment_certificates_project
    ON aec_payment_certificates (project_id, certificate_number);
CREATE INDEX idx_aec_payment_certificates_business
    ON aec_payment_certificates (business_id, status);
CREATE INDEX idx_aec_payment_certificates_contract
    ON aec_payment_certificates (contract_id, period_end) WHERE contract_id IS NOT NULL;

ALTER TABLE aec_payment_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_payment_certificates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_payment_certificates FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 4. §16's "linked BOQ/work packages" — what the claim was measured against
-- ---------------------------------------------------------------------------
CREATE TABLE aec_payment_certificate_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    certificate_id  uuid NOT NULL,
    -- A BOQ item when the line measures priced work, NULL when it measures a
    -- work package the estimate does not carry (a provisional sum, a daywork
    -- sheet). The label is what the client reads either way.
    boq_item_id     uuid REFERENCES aec_boq_items(id) ON DELETE SET NULL,
    label           text NOT NULL CHECK (btrim(label) <> ''),
    amount_rial     bigint NOT NULL DEFAULT 0 CHECK (amount_rial >= 0),
    progress_percent numeric(5, 2)
                        CHECK (progress_percent IS NULL OR progress_percent BETWEEN 0 AND 100),
    position        integer NOT NULL DEFAULT 0 CHECK (position >= 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (business_id, certificate_id)
        REFERENCES aec_payment_certificates (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_payment_certificate_lines_certificate
    ON aec_payment_certificate_lines (certificate_id, position);
CREATE INDEX idx_aec_payment_certificate_lines_boq
    ON aec_payment_certificate_lines (boq_item_id) WHERE boq_item_id IS NOT NULL;

ALTER TABLE aec_payment_certificate_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_payment_certificate_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_payment_certificate_lines FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 5. §33 — the commercial trail, for both subjects
-- ---------------------------------------------------------------------------
-- One table rather than two: a variation and a certificate produce the same kind
-- of entry (an action, a summary, who did it, when) and the two nullable
-- foreign keys plus the CHECK state which subject each row belongs to. The
-- alternative — two identical tables — would be two implementations of the
-- history §33 asks for.
CREATE TABLE aec_commercial_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id    uuid NOT NULL,
    variation_id  uuid,
    certificate_id uuid,
    action        text NOT NULL CHECK (action IN (
        'created', 'updated', 'priced', 'submitted', 'review_started',
        'approved', 'rejected', 'implemented', 'cancelled', 'certified',
        'reopened', 'deleted'
    )),
    summary       text NOT NULL DEFAULT '',
    actor_id      uuid,
    actor_name    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK ((variation_id IS NULL) <> (certificate_id IS NULL)),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, variation_id)
        REFERENCES aec_variations (business_id, id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, certificate_id)
        REFERENCES aec_payment_certificates (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_commercial_events_variation
    ON aec_commercial_events (variation_id, created_at DESC) WHERE variation_id IS NOT NULL;
CREATE INDEX idx_aec_commercial_events_certificate
    ON aec_commercial_events (certificate_id, created_at DESC) WHERE certificate_id IS NOT NULL;
CREATE INDEX idx_aec_commercial_events_project
    ON aec_commercial_events (project_id, created_at DESC);

ALTER TABLE aec_commercial_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_commercial_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_commercial_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 6. The files are the platform's files (the third and fourth register)
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_documents
    ADD COLUMN IF NOT EXISTS variation_id uuid,
    ADD COLUMN IF NOT EXISTS payment_certificate_id uuid;
CREATE INDEX IF NOT EXISTS idx_workspace_documents_variation
    ON workspace_documents (variation_id) WHERE variation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_documents_payment_certificate
    ON workspace_documents (payment_certificate_id) WHERE payment_certificate_id IS NOT NULL;

-- The attachment trigger grows two branches. Replaced rather than extended
-- because a trigger function is one body; the RFI, submittal, site-log and
-- site-issue branches are carried over verbatim from 0199 so this migration
-- cannot silently drop one of them.
CREATE OR REPLACE FUNCTION aec_assert_attachment_owned() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    expected_project uuid;
BEGIN
    IF NEW.rfi_id IS NOT NULL THEN
        SELECT project_id INTO expected_project FROM aec_rfis
         WHERE id = NEW.rfi_id AND business_id = NEW.business_id;
        IF expected_project IS NULL THEN
            RAISE EXCEPTION 'workspace_documents: rfi does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.project_id IS DISTINCT FROM expected_project THEN
            RAISE EXCEPTION 'workspace_documents: an RFI attachment must belong to the same business and project as the RFI'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.submittal_id IS NOT NULL THEN
        SELECT project_id INTO expected_project FROM aec_submittals
         WHERE id = NEW.submittal_id AND business_id = NEW.business_id;
        IF expected_project IS NULL THEN
            RAISE EXCEPTION 'workspace_documents: submittal does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.project_id IS DISTINCT FROM expected_project THEN
            RAISE EXCEPTION 'workspace_documents: a submittal attachment must belong to the same business and project as the submittal'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.site_log_id IS NOT NULL THEN
        SELECT project_id INTO expected_project FROM aec_site_logs
         WHERE id = NEW.site_log_id AND business_id = NEW.business_id;
        IF expected_project IS NULL THEN
            RAISE EXCEPTION 'workspace_documents: site log does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.project_id IS DISTINCT FROM expected_project THEN
            RAISE EXCEPTION 'workspace_documents: a site-log attachment must belong to the same business and project as the log'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.site_issue_id IS NOT NULL THEN
        SELECT project_id INTO expected_project FROM aec_site_issues
         WHERE id = NEW.site_issue_id AND business_id = NEW.business_id;
        IF expected_project IS NULL THEN
            RAISE EXCEPTION 'workspace_documents: site issue does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.project_id IS DISTINCT FROM expected_project THEN
            RAISE EXCEPTION 'workspace_documents: a site-issue attachment must belong to the same business and project as the issue'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.variation_id IS NOT NULL THEN
        SELECT project_id INTO expected_project FROM aec_variations
         WHERE id = NEW.variation_id AND business_id = NEW.business_id;
        IF expected_project IS NULL THEN
            RAISE EXCEPTION 'workspace_documents: variation does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.project_id IS DISTINCT FROM expected_project THEN
            RAISE EXCEPTION 'workspace_documents: a variation attachment must belong to the same business and project as the variation'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.payment_certificate_id IS NOT NULL THEN
        SELECT project_id INTO expected_project FROM aec_payment_certificates
         WHERE id = NEW.payment_certificate_id AND business_id = NEW.business_id;
        IF expected_project IS NULL THEN
            RAISE EXCEPTION 'workspace_documents: payment certificate does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.project_id IS DISTINCT FROM expected_project THEN
            RAISE EXCEPTION 'workspace_documents: a certificate attachment must belong to the same business and project as the certificate'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_workspace_documents_aec_attachment ON workspace_documents;
CREATE TRIGGER trg_workspace_documents_aec_attachment
    BEFORE INSERT OR UPDATE OF rfi_id, submittal_id, site_log_id, site_issue_id,
                                variation_id, payment_certificate_id
    ON workspace_documents
    FOR EACH ROW EXECUTE FUNCTION aec_assert_attachment_owned();

-- ---------------------------------------------------------------------------
-- 7. The references that cannot use a composite key
-- ---------------------------------------------------------------------------
-- A nullable contract, an RFI, a party and two user pointers: `MATCH SIMPLE`
-- would skip the check whenever the column is null, and a composite key with
-- `ON DELETE SET NULL` would null `business_id` with it. Triggers, exactly as
-- 0196–0199 do for the same shapes.
CREATE OR REPLACE FUNCTION aec_assert_variation_references_owned() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
BEGIN
    IF NEW.contract_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM workspace_contracts WHERE id = NEW.contract_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'aec_variations: contract does not exist' USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'aec_variations: contract belongs to another business' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.rfi_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM aec_rfis WHERE id = NEW.rfi_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'aec_variations: linked RFI does not exist' USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'aec_variations: linked RFI belongs to another business' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.responsible_party_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM parties WHERE id = NEW.responsible_party_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'aec_variations: responsible party does not exist' USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'aec_variations: responsible party belongs to another business' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.created_by IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM users WHERE id = NEW.created_by;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'aec_variations: creator belongs to another business' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_aec_variations_references
    BEFORE INSERT OR UPDATE ON aec_variations
    FOR EACH ROW EXECUTE FUNCTION aec_assert_variation_references_owned();

CREATE OR REPLACE FUNCTION aec_assert_certificate_references_owned() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
BEGIN
    IF NEW.contract_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM workspace_contracts WHERE id = NEW.contract_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'aec_payment_certificates: contract does not exist' USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'aec_payment_certificates: contract belongs to another business' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.created_by IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM users WHERE id = NEW.created_by;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'aec_payment_certificates: creator belongs to another business' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_aec_payment_certificates_references
    BEFORE INSERT OR UPDATE ON aec_payment_certificates
    FOR EACH ROW EXECUTE FUNCTION aec_assert_certificate_references_owned();

CREATE OR REPLACE FUNCTION aec_assert_certificate_line_references_owned() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
BEGIN
    IF NEW.boq_item_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM aec_boq_items WHERE id = NEW.boq_item_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'aec_payment_certificate_lines: BOQ item does not exist' USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'aec_payment_certificate_lines: BOQ item belongs to another business' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_aec_payment_certificate_lines_references
    BEFORE INSERT OR UPDATE ON aec_payment_certificate_lines
    FOR EACH ROW EXECUTE FUNCTION aec_assert_certificate_line_references_owned();

CREATE OR REPLACE FUNCTION aec_assert_commercial_event_references_owned() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
BEGIN
    IF NEW.actor_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM users WHERE id = NEW.actor_id;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'aec_commercial_events: actor belongs to another business' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_aec_commercial_events_references
    BEFORE INSERT OR UPDATE ON aec_commercial_events
    FOR EACH ROW EXECUTE FUNCTION aec_assert_commercial_event_references_owned();

-- The commercial block's own contract and responsible manager, which the
-- composite key already covers for tenancy but not for existence of the user.
CREATE OR REPLACE FUNCTION aec_assert_contract_commercial_references_owned() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
BEGIN
    IF NEW.responsible_user_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM users WHERE id = NEW.responsible_user_id;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'aec_contract_commercials: responsible manager belongs to another business' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.created_by IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM users WHERE id = NEW.created_by;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'aec_contract_commercials: creator belongs to another business' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_aec_contract_commercials_references
    BEFORE INSERT OR UPDATE ON aec_contract_commercials
    FOR EACH ROW EXECUTE FUNCTION aec_assert_contract_commercial_references_owned();

-- ---------------------------------------------------------------------------
-- 8. The revised contract value, recomputed by the database (§15, §20)
-- ---------------------------------------------------------------------------
-- §15: an approved variation updates the revised contractual value and must not
-- rewrite the original. So the original lives on `workspace_contracts` and this
-- function recomputes the revised figure from the contract plus its approved
-- variations — called by triggers on every write that could change either side,
-- including a contract whose own value is edited.
CREATE OR REPLACE FUNCTION aec_recompute_contract_revised_value(target_contract uuid)
    RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    original_value bigint;
    approved_total bigint;
BEGIN
    SELECT value_rial INTO original_value FROM workspace_contracts WHERE id = target_contract;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT COALESCE(sum(approved_amount_rial), 0) INTO approved_total
      FROM aec_variations
     WHERE contract_id = target_contract AND status IN ('approved', 'implemented');

    UPDATE aec_contract_commercials
       SET revised_value_rial = COALESCE(original_value, 0) + approved_total,
           updated_at = now()
     WHERE contract_id = target_contract
       AND revised_value_rial IS DISTINCT FROM COALESCE(original_value, 0) + approved_total;
END $$;

CREATE OR REPLACE FUNCTION aec_contract_commercial_sync_revised() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    -- A caller may not set the figure by hand: the composite trigger fills it on
    -- insert and after every relevant variation change.
    NEW.revised_value_rial := COALESCE(
        (SELECT value_rial FROM workspace_contracts WHERE id = NEW.contract_id), 0
    ) + COALESCE((
        SELECT sum(approved_amount_rial) FROM aec_variations
         WHERE contract_id = NEW.contract_id AND status IN ('approved', 'implemented')
    ), 0);
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_contract_commercials_sync_revised
    BEFORE INSERT OR UPDATE ON aec_contract_commercials
    FOR EACH ROW EXECUTE FUNCTION aec_contract_commercial_sync_revised();

CREATE OR REPLACE FUNCTION aec_variation_sync_contract_value() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' AND OLD.contract_id IS NOT NULL THEN
        PERFORM aec_recompute_contract_revised_value(OLD.contract_id);
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.contract_id IS NOT NULL THEN
        PERFORM aec_recompute_contract_revised_value(NEW.contract_id);
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_aec_variations_sync_contract_value
    AFTER INSERT OR UPDATE OF status, approved_amount_rial, contract_id OR DELETE ON aec_variations
    FOR EACH ROW EXECUTE FUNCTION aec_variation_sync_contract_value();

CREATE OR REPLACE FUNCTION aec_contract_value_sync_revised() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    PERFORM aec_recompute_contract_revised_value(NEW.id);
    RETURN NEW;
END $$;

CREATE TRIGGER trg_workspace_contracts_sync_revised
    AFTER UPDATE OF value_rial ON workspace_contracts
    FOR EACH ROW EXECUTE FUNCTION aec_contract_value_sync_revised();

-- ---------------------------------------------------------------------------
-- 9. §15's immutability: a submitted change order is what the client received
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION aec_variation_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'aec_variations: only a draft change order can be deleted'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- What the client was sent cannot change underneath them. The status
        -- chain, the decision's own fields and the implementation date still
        -- move; the *content* does not.
        IF OLD.status NOT IN ('draft', 'priced') THEN
            IF NEW.description IS DISTINCT FROM OLD.description
               OR NEW.reason IS DISTINCT FROM OLD.reason
               OR NEW.source IS DISTINCT FROM OLD.source
               OR NEW.responsible_party_id IS DISTINCT FROM OLD.responsible_party_id
               OR NEW.rfi_id IS DISTINCT FROM OLD.rfi_id
               OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
               OR NEW.estimated_amount_rial IS DISTINCT FROM OLD.estimated_amount_rial
               OR NEW.cost_impact_rial IS DISTINCT FROM OLD.cost_impact_rial
               OR NEW.schedule_impact_days IS DISTINCT FROM OLD.schedule_impact_days
               OR NEW.variation_number IS DISTINCT FROM OLD.variation_number
               OR NEW.project_id IS DISTINCT FROM OLD.project_id
               OR NEW.created_by IS DISTINCT FROM OLD.created_by
            THEN
                RAISE EXCEPTION 'aec_variations: a submitted change order is frozen; reopen it to re-price it'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF OLD.status IN ('implemented', 'cancelled') THEN
            RAISE EXCEPTION 'aec_variations: an implemented or cancelled change order cannot change'
                USING ERRCODE = '23514';
        END IF;
        -- Reopening is a status move, not a content edit, so it passes the
        -- freeze above untouched: the service takes a rejected order back to
        -- `priced` (dropping the agreement nobody honoured), and the *next*
        -- write — the re-pricing — is the one the freeze then lets through,
        -- because the row is `priced` by then.
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_variations_guard
    BEFORE UPDATE OR DELETE ON aec_variations
    FOR EACH ROW EXECUTE FUNCTION aec_variation_guard();

-- ---------------------------------------------------------------------------
-- 10. §16's immutability: a certified claim is history
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION aec_certificate_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    line_total bigint;
    line_count integer;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'aec_payment_certificates: only a draft certificate can be deleted'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'certified' THEN
            RAISE EXCEPTION 'aec_payment_certificates: a certified claim is a record and cannot change'
                USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'cancelled' THEN
            RAISE EXCEPTION 'aec_payment_certificates: a cancelled claim cannot change'
                USING ERRCODE = '23514';
        END IF;
        IF OLD.status <> 'draft' THEN
            IF NEW.gross_rial IS DISTINCT FROM OLD.gross_rial
               OR NEW.advance_recovery_rial IS DISTINCT FROM OLD.advance_recovery_rial
               OR NEW.retention_rial IS DISTINCT FROM OLD.retention_rial
               OR NEW.other_deductions_rial IS DISTINCT FROM OLD.other_deductions_rial
               OR NEW.tax_rial IS DISTINCT FROM OLD.tax_rial
               OR NEW.net_rial IS DISTINCT FROM OLD.net_rial
               OR NEW.period_start IS DISTINCT FROM OLD.period_start
               OR NEW.period_end IS DISTINCT FROM OLD.period_end
               OR NEW.kind IS DISTINCT FROM OLD.kind
               OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
               OR NEW.certificate_number IS DISTINCT FROM OLD.certificate_number
               OR NEW.project_id IS DISTINCT FROM OLD.project_id
               OR NEW.created_by IS DISTINCT FROM OLD.created_by
            THEN
                RAISE EXCEPTION 'aec_payment_certificates: a submitted claim is frozen; return it to draft to re-measure it'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;

    -- The lines, when there are any, are the measurement: a claim whose lines do
    -- not add up to its gross figure is two answers to one question.
    IF NEW.status <> 'draft' THEN
        SELECT count(*), COALESCE(sum(amount_rial), 0) INTO line_count, line_total
          FROM aec_payment_certificate_lines WHERE certificate_id = NEW.id;
        IF line_count > 0 AND line_total <> NEW.gross_rial THEN
            RAISE EXCEPTION 'aec_payment_certificates: the measured lines must add up to the gross amount'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_payment_certificates_guard
    BEFORE UPDATE OR DELETE ON aec_payment_certificates
    FOR EACH ROW EXECUTE FUNCTION aec_certificate_guard();

CREATE OR REPLACE FUNCTION aec_certificate_line_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    parent_status text;
BEGIN
    SELECT status INTO parent_status FROM aec_payment_certificates
     WHERE id = COALESCE(NEW.certificate_id, OLD.certificate_id);
    IF parent_status IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF parent_status <> 'draft' THEN
        RAISE EXCEPTION 'aec_payment_certificate_lines: a claim that has been sent cannot be re-measured'
            USING ERRCODE = '23514';
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_aec_payment_certificate_lines_guard
    BEFORE INSERT OR UPDATE OR DELETE ON aec_payment_certificate_lines
    FOR EACH ROW EXECUTE FUNCTION aec_certificate_line_guard();

-- ---------------------------------------------------------------------------
-- 11. Approvals carry two more subjects (§15's "approvals", §16's certification)
-- ---------------------------------------------------------------------------
-- A submitted change order and a claim awaiting certification both file one
-- `workspace_approvals` row, exactly as a BOQ revision and a submittal revision
-- do — one approval engine, as §24 requires, so they appear in the queue, the
-- dashboard counters and the widgets with no second mechanism. The list is
-- additive and idempotent, as in 0196 and 0198.
ALTER TABLE workspace_approvals DROP CONSTRAINT IF EXISTS workspace_approvals_subject_type_check;
ALTER TABLE workspace_approvals ADD CONSTRAINT workspace_approvals_subject_type_check
    CHECK (subject_type IN (
        'project', 'task', 'document', 'contract', 'estimate_version',
        'submittal_revision', 'variation', 'payment_certificate'
    ));

-- ---------------------------------------------------------------------------
-- 12. The activity feed carries the commercial trail (§33)
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_activity DROP CONSTRAINT IF EXISTS workspace_activity_subject_type_check;
ALTER TABLE workspace_activity ADD CONSTRAINT workspace_activity_subject_type_check
    CHECK (subject_type IN (
        'project', 'task', 'document', 'contract', 'approval', 'member', 'event',
        'estimate', 'document_revision', 'transmittal', 'rfi', 'submittal',
        'site_log', 'site_issue', 'variation', 'payment_certificate'
    ));

-- ---------------------------------------------------------------------------
-- 13. §22's widgets
-- ---------------------------------------------------------------------------
-- §22 names "Financial Exposure", "Payment Certificates" and "Project Margin"
-- for this wave. Two of the three have data behind them now and are seeded; the
-- margin is deliberately absent — revenue recognition does not exist, and the
-- cockpit says so rather than a widget computing a profit nobody has booked.
INSERT INTO ai_widget_templates
  (name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height, created_by)
SELECT v.name, v.description, v.industry, v.source_app, v.required_permissions, v.prompt, v.output_format, v.default_width, v.default_height, 'system'
  FROM (VALUES
    (
      'صورت‌وضعیت‌های در انتظار',
      'صورت‌وضعیت‌ها و گواهی‌های تأییدنشده و مبلغ در گردش آن‌ها',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.view']::text[],
      'صورت‌وضعیت‌های در انتظار تأیید را بنویس: پروژه، قرارداد، شمارهٔ صورت‌وضعیت، دورهٔ اندازه‌گیری، مبلغ ناخالص، کسورات و مبلغ خالص. سپس بگو کدام‌ها بیش از همه معطل مانده‌اند.',
      'bullets',
      2,
      1
    ),
    (
      'ریسک تجاری پروژه‌ها',
      'قراردادهای اصلاح‌شده، تغییرات تأییدشده، وصول‌نشده و ضمانت‌نامه‌های نزدیک به انقضا',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.view']::text[],
      'وضعیت تجاری پروژه‌ها را بنویس: ارزش اصلاح‌شدهٔ قرارداد، مجموع تغییرات تأییدشده، مبلغ تأییدشدهٔ صورت‌وضعیت‌ها، مبلغ صورت‌وضعیت‌شدهٔ پرداخت‌نشده و ضمانت‌نامه‌هایی که تا دو ماه آینده منقضی می‌شوند. هزینهٔ واقعی را از اسناد حسابداری بخوان و اگر در دسترس نیست بگو.',
      'bullets',
      2,
      1
    )
  ) AS v(name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height)
 WHERE NOT EXISTS (
   SELECT 1 FROM ai_widget_templates t
    WHERE t.industry = v.industry AND t.name = v.name
 );
