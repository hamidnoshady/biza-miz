-- ============================================================================
-- 0199_aec_site_execution.sql — issue #799 Wave 7 (§13, "Site operations" +
-- §14, "Inspections, QA/QC and snagging").
--
-- §13 wants the day the site actually had, and §14 wants one register of
-- everything that went wrong on it. Six tables:
--
--   1. `aec_site_logs`                     — §13's daily log header
--   2. `aec_site_log_lines`                — its attendance / plant / delivery
--                                            / delay / incident / instruction
--                                            / visitor lines
--   3. `aec_site_issues`                   — §14's register: inspection
--                                            requests, inspections, NCRs,
--                                            corrective actions, snags, HSE
--                                            observations, handover items
--   4. `aec_site_issue_checks`             — the checklist a quality inspection
--                                            or a handover was carried out
--                                            against, item by item
--   5. `aec_inspection_checklists`         — the firm's reusable checklists
--   6. `aec_inspection_checklist_items`    — and their items
--
-- FIVE RULES THIS FILE EXISTS TO ENFORCE, all in the database rather than only
-- in the service:
--
--   * A SUBMITTED DAY IS A RECORD. Once a log is `submitted` its header *and its
--     lines* accept no change until it is reopened — a guard on the lines too,
--     because a frozen header whose attendance can still be edited freezes
--     nothing. §33 does not ask for a site log to be immutable, so reopening is
--     allowed; what is not allowed is changing a signed day silently.
--   * A CLOSED ISSUE IS HISTORY (§33's "inspection result" and "NCR closeout").
--     Once an issue is closed its content is frozen, its checklist is frozen,
--     and its result can no longer be edited. The close itself must name the
--     verifier and pass the four-eyes rule: the person who fixed it cannot be
--     the person who signs it off (`verified_by <> assigned_to`).
--   * AN INSPECTION ENDS IN A RESULT. Reaching `resolved` for an inspection or a
--     handover requires `result` to be set, and no other kind may carry one —
--     so "was the pour approved?" has one stored answer, not a note somebody has
--     to read.
--   * A CHECKLIST ITEM IS SNAPSHOTTED. The label and the guidance are copied
--     from the template onto the issue, so editing the firm's standard checklist
--     afterwards cannot rewrite what was actually inspected. §33's "inspection
--     result" therefore survives the template being changed or deleted.
--   * THE FILES ARE THE PLATFORM'S FILES. Site photos and evidence are
--     `workspace_documents` rows linked by two new nullable columns, exactly as
--     migration 0198 linked an RFI's attachments — no second upload path, and a
--     photo of a snag shows up in the project's own document list.
--
-- Tenancy and immutability follow 0194/0196/0197/0198 exactly: composite foreign
-- keys to `(business_id, …)`, triggers for the references that cannot use one
-- (users, parties, the self-referencing parent issue), and FORCE RLS with the
-- standard `tenant_isolation` policy on every table.
--
-- Known follow-up (Wave 11), same as 0196–0198: a closed issue cannot be
-- deleted, so a project teardown that cascades through one is refused by these
-- guards. Projects are archived rather than deleted today.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The daily site log (§13)
-- ---------------------------------------------------------------------------
CREATE TABLE aec_site_logs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id          uuid NOT NULL,
    -- One log per project per day. A site that reports twice on the same date
    -- is not keeping a log, and the constraint makes the second report an edit
    -- of the day rather than a second day.
    log_date            date NOT NULL,
    -- §13's "author": the user who wrote the day, denormalised so a printed log
    -- still says who signed it even after the account is deactivated.
    author_user_id      uuid,
    author_name         text NOT NULL DEFAULT '',
    status              text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'submitted')),
    -- §13's narrative: what was done, and the day's conditions. The lists —
    -- attendance, plant, deliveries, delays, incidents, instructions, visitors —
    -- are the lines below, so no count is ever typed twice.
    work_performed      text NOT NULL DEFAULT '',
    weather             text NOT NULL DEFAULT '',
    safety_note         text NOT NULL DEFAULT '',
    notes               text NOT NULL DEFAULT '',
    submitted_by        uuid,
    submitted_by_name   text NOT NULL DEFAULT '',
    submitted_at        timestamptz,
    created_by          uuid,
    created_by_name     text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    UNIQUE (project_id, log_date),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_site_logs_project ON aec_site_logs (project_id, log_date DESC);
CREATE INDEX idx_aec_site_logs_business ON aec_site_logs (business_id);
CREATE INDEX idx_aec_site_logs_draft ON aec_site_logs (business_id, log_date)
    WHERE status = 'draft';

ALTER TABLE aec_site_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_site_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_site_logs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 2. What the day contained, line by line (§13)
-- ---------------------------------------------------------------------------
CREATE TABLE aec_site_log_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    log_id          uuid NOT NULL,
    kind            text NOT NULL CHECK (kind IN (
                        'attendance', 'equipment', 'material', 'delay',
                        'incident', 'instruction', 'visitor'
                    )),
    -- The crew, the machine, the material, or the subject of a delay /
    -- incident / instruction / visit. Required for every kind: a line with no
    -- subject is a line nobody can act on.
    title           text NOT NULL CHECK (btrim(title) <> ''),
    -- The contractor, the plant owner, the supplier, the party responsible for
    -- a delay or an incident. Optional only for the kinds where a party is not
    -- meaningful (`visitor`, `instruction`), which the shape CHECK below states.
    party_id        uuid REFERENCES parties(id) ON DELETE RESTRICT,
    quantity        numeric(20, 3) CHECK (quantity IS NULL OR quantity >= 0),
    unit            text CHECK (unit IS NULL OR btrim(unit) <> ''),
    headcount       integer CHECK (headcount IS NULL OR headcount >= 0),
    hours           numeric(10, 2) CHECK (hours IS NULL OR hours >= 0),
    note            text NOT NULL DEFAULT '',
    position        integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    FOREIGN KEY (business_id, log_id)
        REFERENCES aec_site_logs (business_id, id) ON DELETE CASCADE,
    -- The shape each kind must have, stated once. This is the same table
    -- `src/lib/aec-site.ts` declares as `SITE_LOG_LINE_SHAPES`; keeping the two
    -- in step is what stops a material delivery without a quantity.
    CONSTRAINT aec_site_log_lines_shape CHECK (
        CASE kind
            WHEN 'attendance'  THEN headcount IS NOT NULL
                                    AND quantity IS NULL
            WHEN 'equipment'   THEN quantity IS NOT NULL
                                    AND headcount IS NULL
            WHEN 'material'    THEN quantity IS NOT NULL
                                    AND unit IS NOT NULL
                                    AND btrim(coalesce(unit, '')) <> ''
                                    AND headcount IS NULL
            ELSE quantity IS NULL AND headcount IS NULL
        END
    )
);
CREATE INDEX idx_aec_site_log_lines_log ON aec_site_log_lines (log_id, position);
CREATE INDEX idx_aec_site_log_lines_party ON aec_site_log_lines (party_id)
    WHERE party_id IS NOT NULL;

ALTER TABLE aec_site_log_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_site_log_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_site_log_lines FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. The reusable checklists (§14)
-- ---------------------------------------------------------------------------
-- §14 names "inspection checklists" and a "handover checklist" as artifacts in
-- their own right, and §25 lists "complete checklist" among the critical mobile
-- flows. So the checklist is a template a firm keeps — business-wide, or scoped
-- to one project — and the answers live on the issue (below), snapshotted.
CREATE TABLE aec_inspection_checklists (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- NULL means "every project of this business" — the firm's standard
    -- checklist. A project-scoped one is for the client who insists on theirs.
    project_id      uuid,
    name            text NOT NULL CHECK (btrim(name) <> ''),
    kind            text NOT NULL DEFAULT 'inspection'
                        CHECK (kind IN ('inspection', 'handover')),
    -- The discipline the checklist belongs to, from the AEC specialty
    -- catalogue like every other discipline column in the module.
    discipline      text CHECK (discipline IS NULL OR discipline IN (
                        'architecture', 'structural_engineering', 'civil_engineering',
                        'interior_architecture', 'landscape', 'mep', 'surveying',
                        'project_management', 'construction_management',
                        'site_supervision', 'quantity_surveying'
                    )),
    description     text NOT NULL DEFAULT '',
    is_active       boolean NOT NULL DEFAULT true,
    created_by      uuid,
    created_by_name text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    -- A composite FK to the project cannot carry a nullable left column and
    -- still be enforced (MATCH SIMPLE skips the row), which is exactly what is
    -- wanted: NULL means business-wide, and the trigger below checks the
    -- project's tenancy when there is one.
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_aec_inspection_checklists_shared
    ON aec_inspection_checklists (business_id, name) WHERE project_id IS NULL;
CREATE UNIQUE INDEX idx_aec_inspection_checklists_project
    ON aec_inspection_checklists (project_id, name) WHERE project_id IS NOT NULL;
CREATE INDEX idx_aec_inspection_checklists_business
    ON aec_inspection_checklists (business_id, is_active);

ALTER TABLE aec_inspection_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_inspection_checklists FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_inspection_checklists FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE aec_inspection_checklist_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    checklist_id    uuid NOT NULL,
    title           text NOT NULL CHECK (btrim(title) <> ''),
    -- What "pass" means for this item: a tolerance, a reference to a
    -- specification, the acceptance criterion. Copied onto the issue as well,
    -- so the inspector's record keeps the bar they measured against.
    guidance        text NOT NULL DEFAULT '',
    position        integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    FOREIGN KEY (business_id, checklist_id)
        REFERENCES aec_inspection_checklists (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_inspection_checklist_items_checklist
    ON aec_inspection_checklist_items (checklist_id, position);

ALTER TABLE aec_inspection_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_inspection_checklist_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_inspection_checklist_items FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 4. §14's register — one row per issue, whatever kind it is
-- ---------------------------------------------------------------------------
CREATE TABLE aec_site_issues (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id          uuid NOT NULL,
    -- The day it was observed on, when it was observed on one. Optional: an
    -- NCR can be raised from the office after reading a report.
    --
    -- All three links below are single-column foreign keys to the target's own
    -- primary key rather than composite `(business_id, id)` ones, for the reason
    -- 0194 states: `ON DELETE SET NULL` on a composite key would null
    -- `business_id` too, and that column is NOT NULL. Tenancy and project
    -- agreement are therefore asserted by the reference trigger below, exactly
    -- as the user and party columns are.
    site_log_id         uuid REFERENCES aec_site_logs(id) ON DELETE SET NULL,
    -- The checklist template this issue's items were snapshotted from, kept
    -- for provenance (which standard was this inspected against?).
    checklist_id        uuid REFERENCES aec_inspection_checklists(id) ON DELETE SET NULL,
    -- «SNG-004» — unique per project. Prefix by kind; the service generates the
    -- next one under an advisory lock so two foremen cannot both get -004.
    issue_number        text NOT NULL CHECK (btrim(issue_number) <> ''),
    kind                text NOT NULL CHECK (kind IN (
                            'inspection_request', 'inspection', 'ncr',
                            'corrective_action', 'snag', 'hse_observation', 'handover'
                        )),
    title               text NOT NULL CHECK (btrim(title) <> ''),
    description         text NOT NULL DEFAULT '',
    location            text NOT NULL DEFAULT '',
    category            text CHECK (category IS NULL OR category IN (
                            'structural', 'architectural', 'mep', 'finishing',
                            'civil_site', 'safety', 'documentation', 'other'
                        )),
    severity            text NOT NULL DEFAULT 'medium'
                            CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    -- §14's "responsible party": the contractor or supplier who owes the fix —
    -- always one of the business's own `parties` rows, never a login (§6).
    responsible_party_id uuid REFERENCES parties(id) ON DELETE RESTRICT,
    raised_by           uuid,
    raised_by_name      text NOT NULL DEFAULT '',
    raised_date         date NOT NULL,
    assigned_to         uuid,
    assigned_to_name    text NOT NULL DEFAULT '',
    due_date            date,
    status              text NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'in_progress', 'resolved', 'closed', 'cancelled')),
    -- §14's "inspection result". Present for an inspection or a handover when it
    -- resolves, and for nothing else — see the guard.
    result              text CHECK (result IS NULL OR result IN ('pass', 'pass_with_comments', 'fail')),
    -- What was actually done about it, in the words of whoever did it.
    resolution_note     text NOT NULL DEFAULT '',
    resolved_by         uuid,
    resolved_by_name    text NOT NULL DEFAULT '',
    resolved_at         timestamptz,
    -- §14's "closeout verification": who accepted the fix, when, and with what
    -- remark. The verifier may not be the assignee — the guard below insists.
    verified_by         uuid,
    verified_by_name    text NOT NULL DEFAULT '',
    verified_at         timestamptz,
    closeout_note       text NOT NULL DEFAULT '',
    -- An NCR raised *out of* an inspection, or a corrective action out of an
    -- NCR: the follow-up points at what it came from, so the chain is a read.
    parent_issue_id     uuid REFERENCES aec_site_issues(id) ON DELETE SET NULL,
    created_by          uuid,
    created_by_name     text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    UNIQUE (project_id, issue_number),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_site_issues_project ON aec_site_issues (project_id, issue_number);
CREATE INDEX idx_aec_site_issues_business ON aec_site_issues (business_id);
-- The two queues the product reads: what is open, and what is late.
CREATE INDEX idx_aec_site_issues_open ON aec_site_issues (business_id, due_date)
    WHERE status IN ('open', 'in_progress', 'resolved');
CREATE INDEX idx_aec_site_issues_assignee ON aec_site_issues (assigned_to)
    WHERE status IN ('open', 'in_progress', 'resolved');
CREATE INDEX idx_aec_site_issues_party ON aec_site_issues (responsible_party_id)
    WHERE responsible_party_id IS NOT NULL;
CREATE INDEX idx_aec_site_issues_log ON aec_site_issues (site_log_id)
    WHERE site_log_id IS NOT NULL;
CREATE INDEX idx_aec_site_issues_parent ON aec_site_issues (parent_issue_id)
    WHERE parent_issue_id IS NOT NULL;

ALTER TABLE aec_site_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_site_issues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_site_issues FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 5. The checklist as it was carried out
-- ---------------------------------------------------------------------------
CREATE TABLE aec_site_issue_checks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    issue_id        uuid NOT NULL,
    -- The template item this came from, when it came from one. ON DELETE SET
    -- NULL on purpose: deleting the firm's checklist must not delete the record
    -- of the inspection, which is why the label is snapshotted below.
    checklist_item_id uuid,
    -- Snapshots. The label and the acceptance criterion are what the inspector
    -- actually saw, so editing the template tomorrow cannot rewrite yesterday.
    label           text NOT NULL CHECK (btrim(label) <> ''),
    guidance        text NOT NULL DEFAULT '',
    result          text NOT NULL DEFAULT 'pending'
                        CHECK (result IN ('pending', 'pass', 'fail', 'na')),
    note            text NOT NULL DEFAULT '',
    position        integer NOT NULL DEFAULT 0,
    checked_by      uuid,
    checked_by_name text NOT NULL DEFAULT '',
    checked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    FOREIGN KEY (business_id, issue_id)
        REFERENCES aec_site_issues (business_id, id) ON DELETE CASCADE,
    -- A *single-column* reference, deliberately: a composite FK's ON DELETE SET
    -- NULL nulls every column of the key, `business_id` included, and that column
    -- is NOT NULL — deleting a template item would fail instead of detaching it.
    -- The ownership half of the pair is the trigger below, exactly as
    -- `aec_site_issues.site_log_id`/`checklist_id` do it above.
    FOREIGN KEY (checklist_item_id)
        REFERENCES aec_inspection_checklist_items (id) ON DELETE SET NULL
);
CREATE INDEX idx_aec_site_issue_checks_issue ON aec_site_issue_checks (issue_id, position);

ALTER TABLE aec_site_issue_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_site_issue_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_site_issue_checks FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 6. Photos and evidence: the document table gains the two links (§13, §14)
-- ---------------------------------------------------------------------------
-- §13's "site photos" and §14's "photos, evidence" are the platform's existing
-- document records, exactly as 0198 linked an RFI's attachments. ON DELETE
-- CASCADE takes the *link rows*, never the media file.
ALTER TABLE workspace_documents
    ADD COLUMN IF NOT EXISTS site_log_id uuid REFERENCES aec_site_logs(id) ON DELETE CASCADE;
ALTER TABLE workspace_documents
    ADD COLUMN IF NOT EXISTS site_issue_id uuid REFERENCES aec_site_issues(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_workspace_documents_site_log
    ON workspace_documents (site_log_id) WHERE site_log_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_documents_site_issue
    ON workspace_documents (site_issue_id) WHERE site_issue_id IS NOT NULL;

-- The 0198 guard, extended: an attachment must belong to the same business and
-- the same project as the record it is attached to. The function is replaced
-- (CREATE OR REPLACE) and the trigger re-created with the two new columns in its
-- UPDATE OF list — a trigger that does not watch them would let a site photo
-- point at another project's issue.
CREATE OR REPLACE FUNCTION aec_assert_attachment_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
    owner_project  uuid;
BEGIN
    IF NEW.rfi_id IS NOT NULL THEN
        SELECT business_id, project_id INTO owner_business, owner_project
          FROM aec_rfis WHERE id = NEW.rfi_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'workspace_documents: rfi does not exist'
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF NEW.business_id <> owner_business OR NEW.project_id IS DISTINCT FROM owner_project THEN
            RAISE EXCEPTION 'workspace_documents: an RFI attachment must belong to the same business and project as the RFI'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF NEW.submittal_id IS NOT NULL THEN
        SELECT business_id, project_id INTO owner_business, owner_project
          FROM aec_submittals WHERE id = NEW.submittal_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'workspace_documents: submittal does not exist'
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF NEW.business_id <> owner_business OR NEW.project_id IS DISTINCT FROM owner_project THEN
            RAISE EXCEPTION 'workspace_documents: a submittal attachment must belong to the same business and project as the submittal'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF NEW.site_log_id IS NOT NULL THEN
        SELECT business_id, project_id INTO owner_business, owner_project
          FROM aec_site_logs WHERE id = NEW.site_log_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'workspace_documents: site log does not exist'
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF NEW.business_id <> owner_business OR NEW.project_id IS DISTINCT FROM owner_project THEN
            RAISE EXCEPTION 'workspace_documents: a site-log attachment must belong to the same business and project as the log'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF NEW.site_issue_id IS NOT NULL THEN
        SELECT business_id, project_id INTO owner_business, owner_project
          FROM aec_site_issues WHERE id = NEW.site_issue_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'workspace_documents: site issue does not exist'
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF NEW.business_id <> owner_business OR NEW.project_id IS DISTINCT FROM owner_project THEN
            RAISE EXCEPTION 'workspace_documents: a site-issue attachment must belong to the same business and project as the issue'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_workspace_documents_aec_attachment ON workspace_documents;
CREATE TRIGGER trg_workspace_documents_aec_attachment
    BEFORE INSERT OR UPDATE OF rfi_id, submittal_id, site_log_id, site_issue_id, project_id, business_id
    ON workspace_documents
    FOR EACH ROW EXECUTE FUNCTION aec_assert_attachment_owned();

-- ---------------------------------------------------------------------------
-- 7. Cross-tenant references the composite keys cannot express
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION aec_assert_site_log_references_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.author_user_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users WHERE id = NEW.author_user_id AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_site_logs: author is not a user of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.submitted_by IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users WHERE id = NEW.submitted_by AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_site_logs: submitted_by is not a user of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_site_logs_references
    BEFORE INSERT OR UPDATE ON aec_site_logs
    FOR EACH ROW EXECUTE FUNCTION aec_assert_site_log_references_owned();

CREATE OR REPLACE FUNCTION aec_assert_site_log_line_references_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.party_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM parties WHERE id = NEW.party_id AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_site_log_lines: party is not a party of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_site_log_lines_references
    BEFORE INSERT OR UPDATE ON aec_site_log_lines
    FOR EACH ROW EXECUTE FUNCTION aec_assert_site_log_line_references_owned();

CREATE OR REPLACE FUNCTION aec_assert_site_issue_references_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    parent_project uuid;
BEGIN
    IF NEW.responsible_party_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM parties
         WHERE id = NEW.responsible_party_id AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_site_issues: responsible party is not a party of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.raised_by IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users WHERE id = NEW.raised_by AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_site_issues: raised_by is not a user of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.assigned_to IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users WHERE id = NEW.assigned_to AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_site_issues: assigned_to is not a user of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.resolved_by IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users WHERE id = NEW.resolved_by AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_site_issues: resolved_by is not a user of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.verified_by IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users WHERE id = NEW.verified_by AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_site_issues: verified_by is not a user of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    -- The three nullable links, whose foreign keys are to a bare primary key
    -- and therefore do not carry tenancy. The day must be a day of this
    -- business *and this project*; a project-scoped checklist is not a
    -- company-wide one; a follow-up belongs to the same project as what it came
    -- from and cannot be its own parent.
    IF NEW.site_log_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM aec_site_logs l
         WHERE l.id = NEW.site_log_id AND l.business_id = NEW.business_id
           AND l.project_id = NEW.project_id
    ) THEN
        RAISE EXCEPTION 'aec_site_issues: the site log is not a log of this business and project'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.checklist_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM aec_inspection_checklists c
         WHERE c.id = NEW.checklist_id AND c.business_id = NEW.business_id
           AND (c.project_id IS NULL OR c.project_id = NEW.project_id)
    ) THEN
        RAISE EXCEPTION 'aec_site_issues: checklist is not a checklist of this business and project'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.parent_issue_id IS NOT NULL THEN
        SELECT project_id INTO parent_project
          FROM aec_site_issues WHERE id = NEW.parent_issue_id AND business_id = NEW.business_id;
        IF parent_project IS NULL THEN
            RAISE EXCEPTION 'aec_site_issues: parent issue is not an issue of this business'
                USING ERRCODE = 'check_violation';
        END IF;
        IF parent_project <> NEW.project_id OR NEW.parent_issue_id = NEW.id THEN
            RAISE EXCEPTION 'aec_site_issues: a follow-up must belong to the same project and cannot be its own parent'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_site_issues_references
    BEFORE INSERT OR UPDATE ON aec_site_issues
    FOR EACH ROW EXECUTE FUNCTION aec_assert_site_issue_references_owned();

CREATE OR REPLACE FUNCTION aec_assert_site_issue_check_references_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    issue_kind text;
    issue_status text;
BEGIN
    SELECT kind, status INTO issue_kind, issue_status
      FROM aec_site_issues
     WHERE id = NEW.issue_id AND business_id = NEW.business_id;
    IF issue_kind IS NULL THEN
        RAISE EXCEPTION 'aec_site_issue_checks: issue is not an issue of this business'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    -- §14 pairs a checklist with an inspection and a handover. A snag list has
    -- one row per snag instead, each with its own location and assignee.
    IF issue_kind NOT IN ('inspection', 'handover') THEN
        RAISE EXCEPTION 'aec_site_issue_checks: a checklist belongs to an inspection or a handover'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' AND issue_status IN ('closed', 'cancelled') THEN
        RAISE EXCEPTION 'aec_site_issue_checks: a closed checklist cannot be extended'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.checklist_item_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM aec_inspection_checklist_items i
         WHERE i.id = NEW.checklist_item_id AND i.business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_site_issue_checks: checklist item is not an item of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_site_issue_checks_references
    BEFORE INSERT OR UPDATE ON aec_site_issue_checks
    FOR EACH ROW EXECUTE FUNCTION aec_assert_site_issue_check_references_owned();

CREATE OR REPLACE FUNCTION aec_assert_inspection_checklist_references_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.created_by IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users WHERE id = NEW.created_by AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_inspection_checklists: created_by is not a user of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_inspection_checklists_references
    BEFORE INSERT OR UPDATE ON aec_inspection_checklists
    FOR EACH ROW EXECUTE FUNCTION aec_assert_inspection_checklist_references_owned();

-- ---------------------------------------------------------------------------
-- 8. The daily log's own life cycle (§13)
-- ---------------------------------------------------------------------------
-- A submitted day is frozen until it is reopened, and the freeze covers the
-- header only in appearance — the line guard below covers the rest.
CREATE OR REPLACE FUNCTION aec_site_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    allowed boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'aec_site_logs: the log of % is % and cannot be deleted', OLD.log_date, OLD.status
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        allowed := CASE OLD.status
            WHEN 'draft'     THEN NEW.status = 'submitted'
            WHEN 'submitted' THEN NEW.status = 'draft'
            ELSE false
        END;
        IF NOT allowed THEN
            RAISE EXCEPTION 'aec_site_logs: the log of % cannot move from % to %', OLD.log_date, OLD.status, NEW.status
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- A signed day stays as it was signed: reopening it (status → draft) is the
    -- only way to change anything about it, which keeps the change visible.
    IF OLD.status = 'submitted' AND NEW.status = 'submitted'
       AND (NEW.log_date IS DISTINCT FROM OLD.log_date
            OR NEW.project_id <> OLD.project_id
            OR NEW.work_performed <> OLD.work_performed
            OR NEW.weather <> OLD.weather
            OR NEW.safety_note <> OLD.safety_note
            OR NEW.notes <> OLD.notes
            OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
            OR NEW.author_name <> OLD.author_name) THEN
        RAISE EXCEPTION 'aec_site_logs: the log of % is submitted; reopen it before changing it', OLD.log_date
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_site_logs_guard
    BEFORE UPDATE OR DELETE ON aec_site_logs
    FOR EACH ROW EXECUTE FUNCTION aec_site_log_guard();

-- The lines inherit the header's state: a frozen day whose attendance could
-- still be edited would not be frozen at all. This is the guard 0197 learned it
-- needed for transmittals, applied to the day.
CREATE OR REPLACE FUNCTION aec_site_log_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    log_id_value uuid := COALESCE(NEW.log_id, OLD.log_id);
    log_status text;
BEGIN
    SELECT status INTO log_status FROM aec_site_logs WHERE id = log_id_value;
    -- No row means the header is being deleted right now (a cascade runs after
    -- the parent is gone) and the header's own guard has already refused every
    -- delete but a draft's. A *live* log that is not a draft still freezes its
    -- lines.
    IF log_status IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF log_status <> 'draft' THEN
        RAISE EXCEPTION 'aec_site_log_lines: the log is % and its lines can no longer be changed', log_status
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_aec_site_log_lines_guard
    BEFORE INSERT OR UPDATE OR DELETE ON aec_site_log_lines
    FOR EACH ROW EXECUTE FUNCTION aec_site_log_line_guard();

-- ---------------------------------------------------------------------------
-- 9. The issue register's life cycle (§14, §33)
-- ---------------------------------------------------------------------------
-- One chain for all seven kinds (open → in progress → resolved → closed, with
-- cancelled until work starts and `resolved → in progress` for a failed
-- verification), plus the three rules that make §33's "inspection result" and
-- "NCR closeout" history rather than fields:
--
--   * a result is required to resolve an inspection or a handover, and refused
--     on every other kind;
--   * closing requires a verifier, and the verifier may not be the assignee;
--   * a closed issue accepts no content change and cannot be deleted.
CREATE OR REPLACE FUNCTION aec_site_issue_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    allowed boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'open' THEN
            RAISE EXCEPTION 'aec_site_issues: % is % and cannot be deleted', OLD.issue_number, OLD.status
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        allowed := CASE OLD.status
            WHEN 'open'        THEN NEW.status IN ('in_progress', 'resolved', 'cancelled')
            WHEN 'in_progress' THEN NEW.status IN ('resolved', 'cancelled')
            WHEN 'resolved'    THEN NEW.status IN ('closed', 'in_progress')
            ELSE false
        END;
        IF NOT allowed THEN
            RAISE EXCEPTION 'aec_site_issues: % cannot move from % to %', OLD.issue_number, OLD.status, NEW.status
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.status = 'resolved' THEN
            IF NEW.resolved_by IS NULL THEN
                RAISE EXCEPTION 'aec_site_issues: % must record who resolved it', OLD.issue_number
                    USING ERRCODE = 'check_violation';
            END IF;
            IF NEW.kind IN ('inspection', 'handover') AND NEW.result IS NULL THEN
                RAISE EXCEPTION 'aec_site_issues: % is an inspection and needs a result to resolve', OLD.issue_number
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;

        IF NEW.status = 'closed' THEN
            IF NEW.verified_by IS NULL OR NEW.verified_at IS NULL THEN
                RAISE EXCEPTION 'aec_site_issues: % needs a closeout verification before it can be closed', OLD.issue_number
                    USING ERRCODE = 'check_violation';
            END IF;
            -- The four-eyes rule §14's "closeout verification" implies: whoever
            -- fixed it does not sign it off. The raiser may verify (that is
            -- usually the inspector); the assignee may not.
            IF NEW.assigned_to IS NOT NULL AND NEW.verified_by = NEW.assigned_to THEN
                RAISE EXCEPTION 'aec_site_issues: % cannot be verified by the person it was assigned to', OLD.issue_number
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;

    -- The shape of a result, whatever the transition: only an inspection or a
    -- handover carries one, and it is written before the issue leaves work.
    IF NEW.result IS NOT NULL AND NEW.kind NOT IN ('inspection', 'handover') THEN
        RAISE EXCEPTION 'aec_site_issues: % is a % and cannot carry an inspection result', OLD.issue_number, OLD.kind
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('resolved', 'closed') AND NEW.kind IN ('inspection', 'handover') AND NEW.result IS NULL THEN
        RAISE EXCEPTION 'aec_site_issues: % is an inspection and needs a result', OLD.issue_number
            USING ERRCODE = 'check_violation';
    END IF;

    -- §33: a closed issue is history — and a cancelled one is the same kind of
    -- decision (§10's RFI guard reached the same conclusion). Its identity, its
    -- finding, its result and the note it was closed with cannot be rewritten
    -- afterwards.
    IF OLD.status IN ('closed', 'cancelled') THEN
        RAISE EXCEPTION 'aec_site_issues: % is % and its record can no longer be changed', OLD.issue_number, OLD.status
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_site_issues_guard
    BEFORE UPDATE OR DELETE ON aec_site_issues
    FOR EACH ROW EXECUTE FUNCTION aec_site_issue_guard();

-- A closed issue's checklist is as frozen as the issue: the items are what
-- somebody signed off against.
CREATE OR REPLACE FUNCTION aec_site_issue_check_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    issue_id_value uuid := COALESCE(NEW.issue_id, OLD.issue_id);
    issue_status text;
BEGIN
    SELECT status INTO issue_status FROM aec_site_issues WHERE id = issue_id_value;
    IF issue_status IS NULL THEN
        -- The issue is being deleted (cascade); its own guard decided that.
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF issue_status IN ('closed', 'cancelled') THEN
        RAISE EXCEPTION 'aec_site_issue_checks: the issue is % and its checklist is frozen', issue_status
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_aec_site_issue_checks_guard
    BEFORE INSERT OR UPDATE OR DELETE ON aec_site_issue_checks
    FOR EACH ROW EXECUTE FUNCTION aec_site_issue_check_guard();

-- ---------------------------------------------------------------------------
-- 10. The activity feed carries the day and the register (§33)
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_activity DROP CONSTRAINT IF EXISTS workspace_activity_subject_type_check;
ALTER TABLE workspace_activity ADD CONSTRAINT workspace_activity_subject_type_check
    CHECK (subject_type IN (
        'project', 'task', 'document', 'contract', 'approval', 'member', 'event',
        'estimate', 'document_revision', 'transmittal', 'rfi', 'submittal',
        'site_log', 'site_issue'
    ));

-- ---------------------------------------------------------------------------
-- 11. §22's widgets
-- ---------------------------------------------------------------------------
-- "Today on Site" is the one §22 names for this wave, plus the open-issue queue
-- the same section lists as production delays and snags. Idempotent per
-- (industry, name), like 0195, 0197 and 0198 before them.
INSERT INTO ai_widget_templates
  (name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height, created_by)
SELECT v.name, v.description, v.industry, v.source_app, v.required_permissions, v.prompt, v.output_format, v.default_width, v.default_height, 'system'
  FROM (VALUES
    (
      'امروز در کارگاه',
      'آخرین گزارش روزانهٔ کارگاه‌ها: نیرو، تأخیر و رخداد امروز',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.view']::text[],
      'آخرین گزارش‌های روزانهٔ کارگاه را بنویس: پروژه، تاریخ، تعداد نیرو، مصالح رسیده، تأخیرها و رخدادهای ایمنی. اگر امروز گزارش ثبت نشده، بگو کدام پروژه‌ها گزارش امروز را ندارند.',
      'bullets',
      2,
      1
    ),
    (
      'موارد باز کارگاه',
      'بازرسی‌ها، عدم‌انطباق‌ها و نقص‌های باز و عقب‌افتاده',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.view']::text[],
      'موارد باز کارگاه و کنترل کیفیت را بنویس: شماره، نوع (بازرسی، NCR، نقص، ایمنی)، محل، مسئول، تاریخ سررسید و چند روز از سررسید گذشته است. آن‌هایی که مهلتشان گذشته یا شدتشان بحرانی است را اول فهرست کن.',
      'bullets',
      2,
      1
    )
  ) AS v(name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height)
 WHERE NOT EXISTS (
   SELECT 1 FROM ai_widget_templates t
    WHERE t.industry = v.industry AND t.name = v.name
 );
