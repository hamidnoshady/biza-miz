-- ============================================================================
-- 0198_aec_rfi_and_submittals.sql — issue #799 Wave 6 (§10, "RFI workflow" +
-- §11, "Submittals").
--
-- The two registers a project team actually runs on: the questions asked of the
-- client and the consultant, and the documents they send back and forth until
-- somebody approves one. Both are built on what already exists rather than
-- beside it:
--
--   1. `aec_rfis`                  — §10's fields: number, subject, question,
--                                    who raised it, who owes the answer, the
--                                    party responsible, the drawing it is about,
--                                    dates, response, impacts, status.
--   2. `aec_submittals`            — §11's register entry: number, type, title,
--                                    specification section, the responsible
--                                    party, and the derived latest revision.
--   3. `aec_submittal_revisions`   — one submission of it: revision number,
--                                    status, file (through `workspace_documents`,
--                                    so the Media Library stays the file store),
--                                    submitter, reviewer, dates, response, and
--                                    the decision a reviewer made.
--
-- FOUR RULES THIS FILE EXISTS TO ENFORCE, all in the database rather than only
-- in the service:
--
--   * A SUBMITTED REVISION IS IMMUTABLE. Once a revision leaves `draft` its own
--     row accepts no content change, its status only moves forward
--     (`under_review → approved | approved_with_comments | revise_and_resubmit |
--     rejected`, then `→ closed`), and it cannot be deleted. «Revise & Resubmit»
--     therefore *adds* a revision (the service inserts n+1 in draft) instead of
--     rewriting the one the reviewer saw — which is what makes §11's "approval
--     history" a read rather than a reconstruction.
--   * WHAT WAS ANSWERED STAYS ANSWERED. An RFI's question freezes the moment it
--     is asked, its response freezes the moment it is closed, and neither can be
--     deleted once answered: §33 wants an answer to be history, not a field
--     somebody can quietly edit after the fact.
--   * LATEST REVISION IS DERIVED, NOT TYPED. `aec_submittals` carries
--     `latest_revision_id` / `latest_revision_no` / `latest_revision_status` /
--     `revision_count`, kept by `aec_submittal_revision_totals()`; a client
--     cannot declare a revision current.
--   * IT REUSES THE DOCUMENT, IT DOES NOT DUPLICATE IT. Attachments to an RFI or
--     a submittal are `workspace_documents` rows linked to it (two new nullable
--     columns on that table), and a revision's file is a reference to one — so
--     the Media Library keeps its single storage charge, its single access check
--     and its existing screen.
--
-- Tenancy follows 0194/0196/0197 exactly: composite foreign keys to
-- `(business_id, …)` make a cross-tenant reference impossible at the storage
-- layer, the references that cannot use one (`workspace_documents`, `parties`,
-- users) are guarded by triggers, and every table is FORCE RLS with the standard
-- `tenant_isolation` policy.
--
-- Known follow-up (Wave 11), same as 0196/0197: a frozen revision cannot be
-- deleted, so a project or business teardown that cascades through an answered
-- RFI or a submitted submittal is refused by these guards. Projects are archived
-- rather than deleted today; the teardown path belongs with the cleanup wave.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The RFI register (§10)
-- ---------------------------------------------------------------------------
CREATE TABLE aec_rfis (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id          uuid NOT NULL,
    -- «RFI-014» — required and unique per project, the same rule the drawing
    -- register applies to document numbers: a question without a number cannot
    -- be referred to, and an RFI exists to be referred to.
    rfi_number          text NOT NULL CHECK (btrim(rfi_number) <> ''),
    subject             text NOT NULL CHECK (btrim(subject) <> ''),
    question            text NOT NULL DEFAULT '',
    -- A discipline is one of the AEC specialties (`AEC_SPECIALTIES`), like the
    -- drawing register's, rather than a second vocabulary of its own.
    discipline          text CHECK (discipline IS NULL OR discipline IN (
                            'architecture', 'structural_engineering', 'civil_engineering',
                            'interior_architecture', 'landscape', 'mep', 'surveying',
                            'project_management', 'construction_management',
                            'site_supervision', 'quantity_surveying'
                        )),
    -- Who raised it (a user of this business) and who owes the answer. Both are
    -- plain uuid columns with a tenant trigger rather than composite foreign
    -- keys, for the reason 0194 gives: the constraint would need
    -- `ON DELETE SET NULL`, and a composite key cannot null one column of a NOT
    -- NULL pair. The names are denormalised because an RFI printed for a meeting
    -- must still say who asked.
    raised_by           uuid,
    raised_by_name      text NOT NULL DEFAULT '',
    assigned_to         uuid,
    assigned_to_name    text NOT NULL DEFAULT '',
    -- §10's "responsible party": the client, the consultant, the contractor —
    -- always one of the business's own `parties` rows, never a login (§6).
    responsible_party_id uuid REFERENCES parties(id) ON DELETE RESTRICT,
    -- §10's "related drawing/document": the register entry this question is
    -- about, if any. The revision is deliberately *not* pinned: an RFI is about
    -- a drawing, and the answer usually applies to whichever revision is current
    -- by the time it arrives.
    document_id         uuid REFERENCES aec_documents(id) ON DELETE SET NULL,
    raised_date         date NOT NULL,
    due_date            date,
    response            text NOT NULL DEFAULT '',
    responded_by        uuid,
    responded_by_name   text NOT NULL DEFAULT '',
    response_date       date,
    status              text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'open', 'answered', 'closed', 'cancelled')),
    -- §10's impacts. Money is integer Rial like every other amount in the
    -- platform; the schedule impact is whole days, which is how a program is
    -- actually adjusted.
    cost_impact_rial    bigint CHECK (cost_impact_rial IS NULL OR cost_impact_rial >= 0),
    schedule_impact_days integer CHECK (schedule_impact_days IS NULL OR schedule_impact_days >= 0),
    closed_at           timestamptz,
    created_by          uuid,
    created_by_name     text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    UNIQUE (project_id, rfi_number),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_rfis_project ON aec_rfis (project_id, rfi_number);
CREATE INDEX idx_aec_rfis_business ON aec_rfis (business_id);
-- The two queues the product actually reads: what is open, and what is late.
CREATE INDEX idx_aec_rfis_open ON aec_rfis (business_id, due_date) WHERE status = 'open';
CREATE INDEX idx_aec_rfis_assignee ON aec_rfis (assigned_to) WHERE status = 'open';
CREATE INDEX idx_aec_rfis_party ON aec_rfis (responsible_party_id)
    WHERE responsible_party_id IS NOT NULL;

ALTER TABLE aec_rfis ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_rfis FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_rfis FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 2. The submittal register (§11)
-- ---------------------------------------------------------------------------
-- The register row is what a submittal *is* (its number, its type, the
-- specification section it answers); the revisions below are the submissions
-- made against it. The latest-revision columns are the same shape 0197 uses for
-- a drawing, and for the same reason: "which revision is current" is a question
-- three screens ask, and a derived answer cannot drift from the list.
CREATE TABLE aec_submittals (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id              uuid NOT NULL,
    submittal_number        text NOT NULL CHECK (btrim(submittal_number) <> ''),
    title                   text NOT NULL CHECK (btrim(title) <> ''),
    -- §11's list of types.
    submission_type         text NOT NULL DEFAULT 'shop_drawing'
                                CHECK (submission_type IN (
                                    'shop_drawing', 'material_submission', 'sample',
                                    'method_statement', 'technical_data', 'mockup',
                                    'calculation', 'other'
                                )),
    -- «بخش ۰۷ ۲۱» — the specification section the submission answers, free text
    -- because every client numbers their specifications differently.
    spec_section            text NOT NULL DEFAULT '',
    discipline              text CHECK (discipline IS NULL OR discipline IN (
                                'architecture', 'structural_engineering', 'civil_engineering',
                                'interior_architecture', 'landscape', 'mep', 'surveying',
                                'project_management', 'construction_management',
                                'site_supervision', 'quantity_surveying'
                            )),
    -- §11's "linked specification/drawing": the register entry it belongs to.
    document_id             uuid REFERENCES aec_documents(id) ON DELETE SET NULL,
    -- §11's "submitter" is the *party* that submits; the revision records the
    -- user who actually pressed send.
    responsible_party_id    uuid REFERENCES parties(id) ON DELETE RESTRICT,
    response_required_by    date,
    latest_revision_id      uuid,
    latest_revision_no      integer CHECK (latest_revision_no IS NULL OR latest_revision_no >= 1),
    latest_revision_status  text CHECK (
                                latest_revision_status IS NULL
                                OR latest_revision_status IN (
                                    'draft', 'submitted', 'under_review', 'approved',
                                    'approved_with_comments', 'revise_and_resubmit',
                                    'rejected', 'closed'
                                )
                            ),
    revision_count          integer NOT NULL DEFAULT 0 CHECK (revision_count >= 0),
    notes                   text NOT NULL DEFAULT '',
    created_by              uuid,
    created_by_name         text NOT NULL DEFAULT '',
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    UNIQUE (project_id, submittal_number),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_submittals_project ON aec_submittals (project_id, submittal_number);
CREATE INDEX idx_aec_submittals_business ON aec_submittals (business_id);
CREATE INDEX idx_aec_submittals_waiting
    ON aec_submittals (business_id, latest_revision_status)
    WHERE latest_revision_status IN ('submitted', 'under_review');
CREATE INDEX idx_aec_submittals_party ON aec_submittals (responsible_party_id)
    WHERE responsible_party_id IS NOT NULL;

ALTER TABLE aec_submittals ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_submittals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_submittals FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. One submission of it
-- ---------------------------------------------------------------------------
CREATE TABLE aec_submittal_revisions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    submittal_id        uuid NOT NULL,
    revision_no         integer NOT NULL CHECK (revision_no >= 1),
    -- The file that was submitted: a `workspace_documents` row (0167), which is
    -- how the bytes stay in the Media Library. Nullable, because a submission
    -- can be recorded before its file is filed — but see the guard below: only a
    -- draft may be filed later.
    workspace_document_id uuid REFERENCES workspace_documents(id) ON DELETE SET NULL,
    status              text NOT NULL DEFAULT 'draft'
                            CHECK (status IN (
                                'draft', 'submitted', 'under_review', 'approved',
                                'approved_with_comments', 'revise_and_resubmit',
                                'rejected', 'closed'
                            )),
    submitted_by        uuid,
    submitted_by_name   text NOT NULL DEFAULT '',
    submitted_at        timestamptz,
    due_date            date,
    reviewer_user_id    uuid,
    reviewer_name       text NOT NULL DEFAULT '',
    -- §11's "response": the reviewer's determination in their own words.
    response            text NOT NULL DEFAULT '',
    decided_by          uuid,
    decided_by_name     text NOT NULL DEFAULT '',
    decided_at          timestamptz,
    closed_at           timestamptz,
    notes               text NOT NULL DEFAULT '',
    created_by          uuid,
    created_by_name     text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    UNIQUE (submittal_id, revision_no),
    FOREIGN KEY (business_id, submittal_id)
        REFERENCES aec_submittals (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_submittal_revisions_submittal
    ON aec_submittal_revisions (submittal_id, revision_no);
CREATE INDEX idx_aec_submittal_revisions_business
    ON aec_submittal_revisions (business_id);

ALTER TABLE aec_submittal_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_submittal_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_submittal_revisions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 4. Attachments: the document table gains the two links (§10, §11)
-- ---------------------------------------------------------------------------
-- An RFI and a submittal both list "attachments". The platform already has one
-- place a business's files live — `workspace_documents`, over `media_assets` —
-- and it is already linked to projects, tasks, contracts and parties by exactly
-- this shape of column. Two more nullable columns are therefore the reuse; a
-- second attachment table would be the drift.
--
-- `ON DELETE CASCADE`: deleting the RFI takes its attachment *rows*, never the
-- media file itself, which is the same relationship the document table already
-- has with a deleted task.
ALTER TABLE workspace_documents
    ADD COLUMN IF NOT EXISTS rfi_id uuid REFERENCES aec_rfis(id) ON DELETE CASCADE;
ALTER TABLE workspace_documents
    ADD COLUMN IF NOT EXISTS submittal_id uuid REFERENCES aec_submittals(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_workspace_documents_rfi
    ON workspace_documents (rfi_id) WHERE rfi_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_documents_submittal
    ON workspace_documents (submittal_id) WHERE submittal_id IS NOT NULL;

-- An attachment must belong to the same business — and the same project — as the
-- record it is attached to. The composite foreign key that would say so cannot
-- exist here (`project_id` on `workspace_documents` is nullable and its business
-- key is not part of a composite today), so the trigger says it instead: this is
-- the same job `aec_assert_document_links_owned()` does for 0197's phase and
-- task links.
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

    RETURN NEW;
END $$;

CREATE TRIGGER trg_workspace_documents_aec_attachment
    BEFORE INSERT OR UPDATE OF rfi_id, submittal_id, project_id, business_id ON workspace_documents
    FOR EACH ROW EXECUTE FUNCTION aec_assert_attachment_owned();

-- ---------------------------------------------------------------------------
-- 5. Cross-tenant references the composite keys cannot express
-- ---------------------------------------------------------------------------
-- A user id, a party id and a drawing id arriving from another business would
-- otherwise be written happily: the columns are plain uuids (they must be, to
-- keep `ON DELETE SET NULL`). One function per table, in 0194's shape.
CREATE OR REPLACE FUNCTION aec_assert_rfi_references_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.raised_by IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users WHERE id = NEW.raised_by AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_rfis: raised_by is not a user of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.assigned_to IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users WHERE id = NEW.assigned_to AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_rfis: assigned_to is not a user of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.responsible_party_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM parties
         WHERE id = NEW.responsible_party_id AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_rfis: responsible party is not a party of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM aec_documents
         WHERE id = NEW.document_id AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_rfis: document is not a document of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_rfis_references
    BEFORE INSERT OR UPDATE ON aec_rfis
    FOR EACH ROW EXECUTE FUNCTION aec_assert_rfi_references_owned();

CREATE OR REPLACE FUNCTION aec_assert_submittal_references_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.responsible_party_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM parties
         WHERE id = NEW.responsible_party_id AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_submittals: responsible party is not a party of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM aec_documents
         WHERE id = NEW.document_id AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_submittals: document is not a document of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_submittals_references
    BEFORE INSERT OR UPDATE ON aec_submittals
    FOR EACH ROW EXECUTE FUNCTION aec_assert_submittal_references_owned();

CREATE OR REPLACE FUNCTION aec_assert_submittal_revision_references_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.submitted_by IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users WHERE id = NEW.submitted_by AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_submittal_revisions: submitted_by is not a user of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reviewer_user_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users WHERE id = NEW.reviewer_user_id AND business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'aec_submittal_revisions: reviewer is not a user of this business'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.workspace_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workspace_documents d
          JOIN aec_submittals s ON s.id = NEW.submittal_id
         WHERE d.id = NEW.workspace_document_id AND d.business_id = NEW.business_id
           AND d.project_id = s.project_id
    ) THEN
        RAISE EXCEPTION 'aec_submittal_revisions: the submitted file must be a document of this project'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_submittal_revisions_references
    BEFORE INSERT OR UPDATE ON aec_submittal_revisions
    FOR EACH ROW EXECUTE FUNCTION aec_assert_submittal_revision_references_owned();

-- ---------------------------------------------------------------------------
-- 6. The RFI's own life cycle (§10)
-- ---------------------------------------------------------------------------
-- The status chain is `src/lib/aec-rfi.ts`'s `RFI_TRANSITIONS`, enforced here so
-- that no caller — including a future import, a script or a support query — can
-- walk an RFI backwards. The content rules are §33's: a question that has been
-- asked is history, and an answer that has been given is history the moment the
-- RFI closes.
CREATE OR REPLACE FUNCTION aec_rfi_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    allowed boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'aec_rfis: % is % and cannot be deleted', OLD.rfi_number, OLD.status
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        allowed := CASE OLD.status
            WHEN 'draft'    THEN NEW.status IN ('open', 'cancelled')
            WHEN 'open'     THEN NEW.status IN ('answered', 'cancelled')
            WHEN 'answered' THEN NEW.status = 'closed'
            ELSE false
        END;
        IF NOT allowed THEN
            RAISE EXCEPTION 'aec_rfis: % cannot move from % to %', OLD.rfi_number, OLD.status, NEW.status
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- The question freezes when it is asked.
    IF OLD.status <> 'draft'
       AND (NEW.subject <> OLD.subject
            OR NEW.question <> OLD.question
            OR NEW.raised_date IS DISTINCT FROM OLD.raised_date
            OR NEW.project_id <> OLD.project_id
            OR NEW.rfi_number <> OLD.rfi_number) THEN
        RAISE EXCEPTION 'aec_rfis: % has been asked and its question can no longer be changed', OLD.rfi_number
            USING ERRCODE = 'check_violation';
    END IF;

    -- The answer freezes once it exists: it may be written while the RFI is
    -- open (that is what answering is), never rewritten afterwards — not even by
    -- the close that follows it.
    IF OLD.status IN ('answered', 'closed', 'cancelled')
       AND (NEW.response <> OLD.response
            OR NEW.response_date IS DISTINCT FROM OLD.response_date
            OR NEW.responded_by IS DISTINCT FROM OLD.responded_by
            OR NEW.responded_by_name <> OLD.responded_by_name) THEN
        RAISE EXCEPTION 'aec_rfis: % has been answered and its response can no longer be changed', OLD.rfi_number
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_rfis_guard
    BEFORE UPDATE OR DELETE ON aec_rfis
    FOR EACH ROW EXECUTE FUNCTION aec_rfi_guard();

-- ---------------------------------------------------------------------------
-- 7. The submittal revision's life cycle (§11)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION aec_submittal_revision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    allowed boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'aec_submittal_revisions: revision % of submittal % is % and cannot be deleted',
                OLD.revision_no, OLD.submittal_id, OLD.status
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        allowed := CASE OLD.status
            WHEN 'draft'               THEN NEW.status = 'submitted'
            WHEN 'submitted'           THEN NEW.status = 'under_review'
            WHEN 'under_review'        THEN NEW.status IN (
                                              'approved', 'approved_with_comments',
                                              'revise_and_resubmit', 'rejected'
                                          )
            WHEN 'revise_and_resubmit' THEN NEW.status = 'closed'
            WHEN 'approved'            THEN NEW.status = 'closed'
            WHEN 'approved_with_comments' THEN NEW.status = 'closed'
            WHEN 'rejected'            THEN NEW.status = 'closed'
            ELSE false
        END;
        IF NOT allowed THEN
            RAISE EXCEPTION 'aec_submittal_revisions: revision % cannot move from % to %',
                OLD.revision_no, OLD.status, NEW.status
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- Content freezes the moment the revision leaves draft, and so does the
    -- record of who sent it and who is reviewing it: §33 wants a determination
    -- to be history, and a reviewer's name is part of what was decided. The
    -- columns of the later *stages* — `response`, `decided_by`, `decided_at`,
    -- `closed_at` — are written by the transitions above and are deliberately
    -- not in this list, or «تأیید» could not be recorded at all.
    IF OLD.status <> 'draft'
       AND (NEW.revision_no <> OLD.revision_no
            OR NEW.submittal_id <> OLD.submittal_id
            OR NEW.workspace_document_id IS DISTINCT FROM OLD.workspace_document_id
            OR NEW.notes <> OLD.notes
            OR NEW.due_date IS DISTINCT FROM OLD.due_date
            OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
            OR NEW.submitted_by_name <> OLD.submitted_by_name
            OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
            OR NEW.created_by IS DISTINCT FROM OLD.created_by
            OR NEW.created_by_name <> OLD.created_by_name
            OR NEW.created_at IS DISTINCT FROM OLD.created_at
            -- The reviewer is claimed by the transition itself — picking the
            -- submission up (`under_review`) or deciding it — because a revision
            -- may be submitted without knowing who will review it. Changing the
            -- reviewer *without* a transition is rewriting who reviewed it.
            OR (NEW.status IS NOT DISTINCT FROM OLD.status
                AND (NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id
                     OR NEW.reviewer_name <> OLD.reviewer_name))) THEN
        RAISE EXCEPTION 'aec_submittal_revisions: revision % of submittal % has been submitted and its content is frozen',
            OLD.revision_no, OLD.submittal_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_submittal_revisions_guard
    BEFORE UPDATE OR DELETE ON aec_submittal_revisions
    FOR EACH ROW EXECUTE FUNCTION aec_submittal_revision_guard();

-- ---------------------------------------------------------------------------
-- 8. The register's derived latest revision
-- ---------------------------------------------------------------------------
-- Same shape and same reason as 0197's `aec_document_revision_totals()`: the
-- register is one indexed read, "which revision is current" cannot drift, and a
-- client cannot declare a revision current by writing the column.
CREATE OR REPLACE FUNCTION aec_submittal_revision_totals() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target uuid;
BEGIN
    target := COALESCE(NEW.submittal_id, OLD.submittal_id);
    -- The register's guard refuses any other write to the four derived columns,
    -- so the function that computes them announces itself here. Local to the
    -- transaction, so a failed statement cannot leave it set for the next one.
    PERFORM set_config('aec.deriving_submittal_totals', 'on', true);
    UPDATE aec_submittals s
       SET latest_revision_id = latest.id,
           latest_revision_no = latest.revision_no,
           latest_revision_status = latest.status,
           revision_count = totals.count,
           updated_at = now()
      FROM (
        SELECT id, revision_no, status
          FROM aec_submittal_revisions
         WHERE submittal_id = target
         ORDER BY revision_no DESC
         LIMIT 1
      ) AS latest
     CROSS JOIN (
        SELECT count(*)::integer AS count
          FROM aec_submittal_revisions
         WHERE submittal_id = target
     ) AS totals
     WHERE s.id = target;
    -- Removing the last revision (a draft that was withdrawn) clears the
    -- derived columns rather than leaving the register pointing at nothing.
    IF NOT FOUND THEN
        UPDATE aec_submittals s
           SET latest_revision_id = NULL, latest_revision_no = NULL,
               latest_revision_status = NULL, revision_count = 0, updated_at = now()
         WHERE s.id = target;
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_aec_submittal_revision_totals
    AFTER INSERT OR UPDATE OR DELETE ON aec_submittal_revisions
    FOR EACH ROW EXECUTE FUNCTION aec_submittal_revision_totals();

-- The register's two editable metadata fields are frozen once a revision is out
-- with a reviewer: changing the specification section a submission answers,
-- after it was reviewed, would rewrite what was approved. Everything derived
-- (the latest-revision columns) is the trigger's business, not a caller's.
CREATE OR REPLACE FUNCTION aec_submittal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- The four derived columns belong to `aec_submittal_revision_totals()`.
    -- Allowing a caller to type one would let a register row declare a revision
    -- current that no reviewer ever approved, so a direct write is refused
    -- rather than silently corrected: the service never sends these columns.
    IF TG_OP = 'UPDATE'
       -- `aec_submittal_revision_totals()` sets this marker for the duration of
       -- its own write; anything else touching the four columns is a caller
       -- typing a value the register is supposed to compute.
       AND current_setting('aec.deriving_submittal_totals', true) IS DISTINCT FROM 'on'
       AND (NEW.latest_revision_id IS DISTINCT FROM OLD.latest_revision_id
            OR NEW.latest_revision_no IS DISTINCT FROM OLD.latest_revision_no
            OR NEW.latest_revision_status IS DISTINCT FROM OLD.latest_revision_status
            OR NEW.revision_count IS DISTINCT FROM OLD.revision_count) THEN
        RAISE EXCEPTION 'aec_submittals: % carries a derived latest revision; it is computed from its revisions',
            OLD.submittal_number
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.latest_revision_status IS NOT NULL
       AND OLD.latest_revision_status <> 'draft'
       AND (NEW.submittal_number <> OLD.submittal_number
            OR NEW.project_id <> OLD.project_id
            OR NEW.spec_section <> OLD.spec_section
            OR NEW.submission_type <> OLD.submission_type) THEN
        RAISE EXCEPTION 'aec_submittals: % has a revision under review and its identity can no longer be changed',
            OLD.submittal_number
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.latest_revision_status IS NOT NULL
           AND OLD.latest_revision_status <> 'draft' THEN
            RAISE EXCEPTION 'aec_submittals: % has submitted revisions and cannot be deleted', OLD.submittal_number
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_submittals_guard
    BEFORE UPDATE OR DELETE ON aec_submittals
    FOR EACH ROW EXECUTE FUNCTION aec_submittal_guard();

-- ---------------------------------------------------------------------------
-- 9. Approvals carry a sixth subject (§11's review, §24's permission split)
-- ---------------------------------------------------------------------------
-- A submitted revision files one `workspace_approvals` row, exactly as a BOQ
-- revision does, so §11's review appears in the approvals queue, the dashboard
-- counters and the widgets with no second approval mechanism — and is decided on
-- `workspace.approve`, the key no role below manager holds by preset. The list
-- is additive and idempotent, as in 0196.
ALTER TABLE workspace_approvals DROP CONSTRAINT IF EXISTS workspace_approvals_subject_type_check;
ALTER TABLE workspace_approvals ADD CONSTRAINT workspace_approvals_subject_type_check
    CHECK (subject_type IN ('project', 'task', 'document', 'contract', 'estimate_version', 'submittal_revision'));

-- ---------------------------------------------------------------------------
-- 10. The activity feed carries the two registers (§33)
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_activity DROP CONSTRAINT IF EXISTS workspace_activity_subject_type_check;
ALTER TABLE workspace_activity ADD CONSTRAINT workspace_activity_subject_type_check
    CHECK (subject_type IN (
        'project', 'task', 'document', 'contract', 'approval', 'member', 'event',
        'estimate', 'document_revision', 'transmittal', 'rfi', 'submittal'
    ));

-- ---------------------------------------------------------------------------
-- 11. §22's two widgets
-- ---------------------------------------------------------------------------
-- «RFIs Waiting» and «Submittals Waiting», seeded for the industry and
-- idempotent per (industry, name) like 0195 and 0197 before them. The remaining
-- entries of §22's list still name sections that do not exist yet, and a
-- recommended widget for a section with no data is a prompt that can only
-- hallucinate.
INSERT INTO ai_widget_templates
  (name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height, created_by)
SELECT v.name, v.description, v.industry, v.source_app, v.required_permissions, v.prompt, v.output_format, v.default_width, v.default_height, 'system'
  FROM (VALUES
    (
      'RFIهای بدون پاسخ',
      'درخواست‌های اطلاعات باز و عقب‌افتادهٔ پروژه‌های فعال',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.view']::text[],
      'RFIهای باز پروژه‌های فعال را بنویس: شماره، موضوع، مسئول پاسخ، تاریخ سررسید و چند روز از سررسید گذشته است. آن‌هایی که سررسیدشان گذشته را اول فهرست کن.',
      'bullets',
      2,
      1
    ),
    (
      'سابمیتال‌های منتظر تأیید',
      'ارسال‌هایی که در دست بررسی‌اند یا پاسخشان دیر شده است',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.view']::text[],
      'سابمیتال‌هایی که آخرین بازنگری‌شان «ارسال‌شده» یا «در حال بررسی» است را بنویس: شماره، عنوان، نوع، بازبین، تاریخ سررسید و آن‌هایی که دیر شده‌اند. سابمیتال‌هایی که برای اصلاح به پیمانکار برگشته‌اند را جدا کن.',
      'bullets',
      2,
      1
    )
  ) AS v(name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height)
 WHERE NOT EXISTS (
   SELECT 1 FROM ai_widget_templates t
    WHERE t.industry = v.industry AND t.name = v.name
 );
