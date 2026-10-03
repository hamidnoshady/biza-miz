-- ============================================================================
-- 0197_aec_document_control.sql — issue #799 Wave 5 (§9, "Drawing and document
-- control" + §12, "Transmittals and formal correspondence").
--
-- The register a construction business actually keeps: what a drawing is, which
-- revision of it is current, and what exactly left the office, to whom, and
-- when. Built on the pieces that already exist rather than beside them:
--
--   1. `aec_documents`           — the register entry: a document number (and
--                                  an optional drawing number), a title, a type
--                                  and a discipline, on a project, optionally
--                                  at a phase or on a task.
--   2. `aec_document_revisions`  — one revision of it: code, date, issue
--                                  purpose, status, the file (through
--                                  `workspace_documents`, so the Media Library
--                                  stays the file store), who prepared,
--                                  checked and approved it, who issued it.
--   3. `aec_transmittals`        — §12's formal correspondence: number, sender,
--                                  issue date, purpose, comments.
--   4. `aec_transmittal_items`   — the exact revisions included, with the
--                                  document number/title/code/purpose
--                                  snapshotted onto the line.
--   5. `aec_transmittal_recipients` — who received it, and whether they have
--                                  acknowledged receipt.
--
-- FOUR RULES THIS FILE EXISTS TO ENFORCE, all in the database rather than only
-- in the service:
--
--   * AN ISSUED REVISION IS IMMUTABLE. Once a revision leaves `draft` its own
--     row accepts no content change, its status only moves forward
--     (`draft → issued → superseded`), and it cannot be deleted. The file
--     behind it is protected too: `aec_freeze_issued_revision_file()` refuses a
--     content edit to the `workspace_documents` row a non-draft revision points
--     at, so "new revisions must not overwrite historical approved files" is a
--     constraint and not a convention.
--   * WHAT WAS ISSUED STAYS ISSUED. A transmittal's number, sender, date,
--     purpose, lines and recipients are frozen from the moment it is issued;
--     the only write it still accepts is a recipient's acknowledgement (and the
--     flip to `acknowledged` once every recipient who must sign has signed). A
--     line additionally snapshots the revision's identity *onto itself*, so the
--     answer to §12's question — "what exactly was issued, in which revision,
--     to whom, and when?" — does not depend on joining to a row some later wave
--     might move.
--   * LATEST REVISION IS DERIVED, NOT TYPED. `aec_documents` carries
--     `latest_revision_id` / `latest_revision_code` / `revision_count`, kept by
--     `aec_document_revision_totals()`; a client cannot declare a revision
--     current. Full history stays readable at its own id — the whole point of
--     versioning a drawing.
--   * IT REUSES THE DOCUMENT, IT DOES NOT DUPLICATE IT. The bytes are the
--     Media Library's and the file row is `workspace_documents` (0167). A
--     revision stores a *reference* to that row, which is why documents keep
--     their comments, their review status and their existing screen.
--
-- Tenancy follows 0194/0196 exactly: composite foreign keys to
-- `(business_id, …)` make a cross-tenant reference impossible at the storage
-- layer, the two references that cannot use one (`workspace_documents`,
-- `parties`) are guarded by a trigger, and every table is FORCE RLS with the
-- standard `tenant_isolation` policy.
--
-- Known follow-up (Wave 11): as in 0196, a frozen historical row cannot be
-- deleted, so a project or business teardown that cascades through an *issued*
-- revision or transmittal is refused by these guards. Projects are archived
-- rather than deleted today, so nothing hits it yet; the teardown path should
-- either archive too or run with the guards suspended, and that belongs with
-- the cleanup wave rather than hidden here.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The register entry
-- ---------------------------------------------------------------------------
-- One row per document a business controls: «نقشهٔ معماری طبقهٔ سوم» with
-- number A-103. The number is the register's key and is unique per project —
-- two drawings may share a title, never a number.
CREATE TABLE aec_documents (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id          uuid NOT NULL,
    -- «A-103» — the register number. Required, because a document without a
    -- number is not in a register.
    document_number     text NOT NULL CHECK (btrim(document_number) <> ''),
    -- «A-103-S» — optional, because a specification or a report has a document
    -- number and no drawing number at all.
    drawing_number      text NOT NULL DEFAULT '',
    title               text NOT NULL CHECK (btrim(title) <> ''),
    document_type       text NOT NULL DEFAULT 'drawing'
                            CHECK (document_type IN (
                                'drawing', 'specification', 'report', 'calculation',
                                'shop_drawing', 'method_statement', 'as_built', 'other'
                            )),
    -- A discipline is one of the AEC specialties (`AEC_SPECIALTIES` in
    -- `src/lib/aec.ts`) rather than a second vocabulary of its own; NULL is
    -- allowed for a general document that belongs to none of them.
    discipline          text CHECK (discipline IS NULL OR discipline IN (
                            'architecture', 'structural_engineering', 'civil_engineering',
                            'interior_architecture', 'landscape', 'mep', 'surveying',
                            'project_management', 'construction_management',
                            'site_supervision', 'quantity_surveying'
                        )),
    -- §9's "related project/phase/task". Phase and task are plain uuid columns
    -- with a tenant trigger (below) rather than composite foreign keys, for the
    -- same reason 0194 gives for parties: the constraint would need
    -- `ON DELETE SET NULL`, and a composite key cannot null one column of a
    -- NOT NULL pair.
    phase_id            uuid,
    task_id             uuid,
    notes               text NOT NULL DEFAULT '',
    -- The latest revision, maintained by `aec_document_revision_totals()`.
    -- Denormalised so the register is one indexed read and never re-derives
    -- "what is current" per row.
    latest_revision_id  uuid,
    latest_revision_no  integer CHECK (latest_revision_no IS NULL OR latest_revision_no >= 1),
    latest_revision_code text NOT NULL DEFAULT '',
    latest_revision_status text CHECK (
                            latest_revision_status IS NULL
                            OR latest_revision_status IN ('draft', 'issued', 'superseded')
                        ),
    revision_count      integer NOT NULL DEFAULT 0 CHECK (revision_count >= 0),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by_name     text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    UNIQUE (project_id, document_number),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_documents_project ON aec_documents (project_id, document_number);
CREATE INDEX idx_aec_documents_business ON aec_documents (business_id);
CREATE INDEX idx_aec_documents_discipline
    ON aec_documents (project_id, discipline) WHERE discipline IS NOT NULL;

ALTER TABLE aec_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_documents FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 2. A revision of it
-- ---------------------------------------------------------------------------
-- The revision *is* the thing a transmittal issues, and it is the thing that
-- freezes. `revision_no` orders the chain (1, 2, 3 …) and `revision_code` is
-- the label a drawing office writes in the corner («01», «A», «C2») — kept
-- separate because numbering and labelling are genuinely different choices.
--
-- The file is `workspace_document_id`: the row in 0167's `workspace_documents`
-- that carries the media asset, the title and the review status. A revision
-- may exist before its file arrives (a register is often started from a
-- transmittal log), so it is nullable.
CREATE TABLE aec_document_revisions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    document_id         uuid NOT NULL,
    revision_no         integer NOT NULL CHECK (revision_no >= 1),
    revision_code       text NOT NULL CHECK (btrim(revision_code) <> ''),
    revision_date       date,
    -- §9's suggested list, verbatim. `wip` ("work in progress") is what a
    -- draft is; the rest are chosen when the revision is issued.
    issue_purpose       text NOT NULL DEFAULT 'wip'
                            CHECK (issue_purpose IN (
                                'wip', 'for_review', 'for_approval', 'for_tender',
                                'for_construction', 'as_built', 'for_information'
                            )),
    status              text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'issued', 'superseded')),
    -- §9's "created by / checked by / approved by". The preparer is the app
    -- user who registered the revision; the checker and the approver are names,
    -- because a checker is routinely an engineer at another firm who will never
    -- have an account here (issue §6: external parties get no business-wide
    -- access, and inventing them an account to record a name would be exactly
    -- that).
    prepared_by_name    text NOT NULL DEFAULT '',
    checked_by_name     text NOT NULL DEFAULT '',
    approved_by_name    text NOT NULL DEFAULT '',
    notes               text NOT NULL DEFAULT '',
    workspace_document_id uuid REFERENCES workspace_documents(id) ON DELETE CASCADE,
    issued_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    issued_by_name      text NOT NULL DEFAULT '',
    issued_at           timestamptz,
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by_name     text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    UNIQUE (document_id, revision_no),
    UNIQUE (document_id, revision_code),
    FOREIGN KEY (business_id, document_id)
        REFERENCES aec_documents (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_revisions_document
    ON aec_document_revisions (document_id, revision_no DESC);
CREATE INDEX idx_aec_revisions_business ON aec_document_revisions (business_id);
CREATE INDEX idx_aec_revisions_document_file
    ON aec_document_revisions (workspace_document_id)
    WHERE workspace_document_id IS NOT NULL;
-- The register's own read: "the current revision of every drawing" without
-- touching the frozen ones.
CREATE INDEX idx_aec_revisions_issued
    ON aec_document_revisions (document_id, revision_no DESC)
    WHERE status <> 'superseded';

ALTER TABLE aec_document_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_document_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_document_revisions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. A transmittal (§12)
-- ---------------------------------------------------------------------------
-- §12's list, one column each: number, sender, issue date, purpose, comments.
-- Recipients are rows (a transmittal goes to several people at once) and the
-- documents are rows too, so "exact document revisions included" is a real
-- relation rather than a text field nobody can audit.
CREATE TABLE aec_transmittals (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id          uuid NOT NULL,
    transmittal_number  text NOT NULL CHECK (btrim(transmittal_number) <> ''),
    subject             text NOT NULL DEFAULT '',
    -- NULL means "us" — the business itself is the sender, which is the common
    -- case; a consultancy issuing on somebody else's behalf names the party.
    sender_party_id     uuid REFERENCES parties(id) ON DELETE SET NULL,
    issue_date          date,
    purpose             text NOT NULL DEFAULT 'for_review'
                            CHECK (purpose IN (
                                'wip', 'for_review', 'for_approval', 'for_tender',
                                'for_construction', 'as_built', 'for_information'
                            )),
    comments            text NOT NULL DEFAULT '',
    status              text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'issued', 'acknowledged')),
    issued_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    issued_by_name      text NOT NULL DEFAULT '',
    issued_at           timestamptz,
    acknowledged_at     timestamptz,
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by_name     text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    UNIQUE (project_id, transmittal_number),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_transmittals_project
    ON aec_transmittals (project_id, issue_date DESC NULLS LAST, created_at DESC);
CREATE INDEX idx_aec_transmittals_business ON aec_transmittals (business_id);

ALTER TABLE aec_transmittals ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_transmittals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_transmittals FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 4. What was in it
-- ---------------------------------------------------------------------------
-- The snapshot columns are the answer to §12's question and they are written by
-- a trigger from the revision, never by the caller: at the moment a line is
-- added it records which document, which revision and which purpose went out,
-- so the transmittal remains a complete record even if the register is later
-- reorganised. Once the transmittal is issued the line is frozen anyway.
CREATE TABLE aec_transmittal_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    transmittal_id      uuid NOT NULL,
    revision_id         uuid NOT NULL REFERENCES aec_document_revisions(id) ON DELETE CASCADE,
    document_number     text NOT NULL DEFAULT '',
    document_title      text NOT NULL DEFAULT '',
    revision_code       text NOT NULL DEFAULT '',
    issue_purpose       text NOT NULL DEFAULT 'wip',
    note                text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    UNIQUE (transmittal_id, revision_id),
    FOREIGN KEY (business_id, transmittal_id)
        REFERENCES aec_transmittals (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_transmittal_items_transmittal ON aec_transmittal_items (transmittal_id);
CREATE INDEX idx_aec_transmittal_items_revision ON aec_transmittal_items (revision_id);

ALTER TABLE aec_transmittal_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_transmittal_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_transmittal_items FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 5. Who received it
-- ---------------------------------------------------------------------------
-- §12's "acknowledgement/receipt where required": the requirement is a flag on
-- the recipient, the receipt is a timestamp and a name on the same row. A
-- recipient is a `parties` row and never a user account — the employer's
-- document controller does not get a login here (§6).
CREATE TABLE aec_transmittal_recipients (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    transmittal_id          uuid NOT NULL,
    party_id                uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    -- A courtesy copy needs no signature; a shop drawing handed to the
    -- contractor does.
    requires_acknowledgement boolean NOT NULL DEFAULT true,
    acknowledged_at         timestamptz,
    acknowledged_by_name    text NOT NULL DEFAULT '',
    note                    text NOT NULL DEFAULT '',
    created_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    UNIQUE (transmittal_id, party_id),
    FOREIGN KEY (business_id, transmittal_id)
        REFERENCES aec_transmittals (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_transmittal_recipients_transmittal
    ON aec_transmittal_recipients (transmittal_id);
CREATE INDEX idx_aec_transmittal_recipients_party ON aec_transmittal_recipients (party_id);

ALTER TABLE aec_transmittal_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_transmittal_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_transmittal_recipients FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 6. The register's aggregates — "latest revision" is a derived fact
-- ---------------------------------------------------------------------------
-- The highest `revision_no` wins, whether or not it has been issued: a drawing
-- at revision C that is still work-in-progress is *the current revision* of
-- that drawing, and the register says so. Superseded history stays visible
-- through the revisions themselves.
CREATE OR REPLACE FUNCTION aec_document_revision_totals() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target uuid;
    latest record;
BEGIN
    target := COALESCE(NEW.document_id, OLD.document_id);
    SELECT r.id, r.revision_no, r.revision_code, r.status
      INTO latest
      FROM aec_document_revisions r
     WHERE r.document_id = target
     ORDER BY r.revision_no DESC
     LIMIT 1;
    UPDATE aec_documents d
       SET latest_revision_id = latest.id,
           latest_revision_no = latest.revision_no,
           latest_revision_code = COALESCE(latest.revision_code, ''),
           latest_revision_status = latest.status,
           revision_count = (SELECT count(*) FROM aec_document_revisions r WHERE r.document_id = target),
           updated_at = now()
     WHERE d.id = target;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_aec_revisions_document_totals
    AFTER INSERT OR UPDATE OR DELETE ON aec_document_revisions
    FOR EACH ROW EXECUTE FUNCTION aec_document_revision_totals();

-- ---------------------------------------------------------------------------
-- 7. The revision guard — "an issued revision is immutable"
-- ---------------------------------------------------------------------------
-- As in 0196, the rule is stated once and enforced for the service, for a
-- hand-run UPDATE and for the importer alike:
--
--   * the status only moves forward — draft → issued → superseded, and
--     a draft may return to draft (edit) but nothing else;
--   * once it is no longer draft, no column of content may change: not the
--     code, not the date, not the purpose, not the file, not the names;
--   * and it cannot be deleted. History is not editable, and it is not
--     removable either — a revision that should not have been issued is
--     superseded by the next one, which is what a drawing register does.
CREATE OR REPLACE FUNCTION aec_document_revision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    allowed boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'aec_document_revisions: only a draft revision can be deleted'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status IN ('issued', 'superseded') THEN
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            allowed := (OLD.status = 'issued' AND NEW.status = 'superseded');
            IF NOT allowed THEN
                RAISE EXCEPTION 'aec_document_revisions: illegal status transition % -> %',
                    OLD.status, NEW.status USING ERRCODE = 'check_violation';
            END IF;
        END IF;
        IF NEW.id <> OLD.id
           OR NEW.business_id <> OLD.business_id
           OR NEW.document_id <> OLD.document_id
           OR NEW.revision_no <> OLD.revision_no
           OR NEW.revision_code <> OLD.revision_code
           OR NEW.revision_date IS DISTINCT FROM OLD.revision_date
           OR NEW.issue_purpose <> OLD.issue_purpose
           OR NEW.prepared_by_name <> OLD.prepared_by_name
           OR NEW.checked_by_name <> OLD.checked_by_name
           OR NEW.approved_by_name <> OLD.approved_by_name
           OR NEW.notes <> OLD.notes
           OR NEW.workspace_document_id IS DISTINCT FROM OLD.workspace_document_id THEN
            RAISE EXCEPTION 'aec_document_revisions: an issued revision is a historical record'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        -- Still a draft: the status may only become `issued`.
        IF NEW.status <> 'draft' AND NEW.status <> 'issued' THEN
            RAISE EXCEPTION 'aec_document_revisions: a draft revision can only be issued, not %',
                NEW.status USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_document_revisions_guard
    BEFORE UPDATE OR DELETE ON aec_document_revisions
    FOR EACH ROW EXECUTE FUNCTION aec_document_revision_guard();

-- ---------------------------------------------------------------------------
-- 8. The file behind an issued revision is frozen too
-- ---------------------------------------------------------------------------
-- §9's "new revisions must not overwrite historical approved files" is about
-- the *file*, not only the metadata row: without this, repointing a revision's
-- `workspace_documents` row at a new media asset (through the documents screen,
-- which is a different code path entirely) would silently change what was
-- issued. Content columns are frozen; the review status, the tags and the
-- description stay editable, because a document's review state is a separate
-- conversation that the approval engine already owns.
CREATE OR REPLACE FUNCTION aec_freeze_issued_revision_file() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM aec_document_revisions r
         WHERE r.workspace_document_id = OLD.id
           AND r.status <> 'draft'
    ) THEN
        IF NEW.media_asset_id IS DISTINCT FROM OLD.media_asset_id
           OR NEW.title <> OLD.title
           OR NEW.version <> OLD.version
           OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
           OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
            RAISE EXCEPTION 'workspace_documents: this file backs an issued drawing revision and cannot be changed'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_workspace_documents_aec_revision_freeze
    BEFORE UPDATE ON workspace_documents
    FOR EACH ROW EXECUTE FUNCTION aec_freeze_issued_revision_file();

-- ---------------------------------------------------------------------------
-- 9. The transmittal guard — "what was issued stays issued"
-- ---------------------------------------------------------------------------
-- Two transitions and one freeze, plus the two preconditions that make the
-- issue act meaningful:
--
--   * `draft → issued` requires at least one line and at least one recipient —
--     a transmittal that issued nothing to nobody is not a record of anything;
--   * `issued → acknowledged` requires every recipient who must sign to have
--     signed, which is what §12's "acknowledgement where required" means once
--     it is checked rather than hoped for.
CREATE OR REPLACE FUNCTION aec_transmittal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    stuck integer;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'aec_transmittals: an issued transmittal cannot be deleted'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF OLD.status = 'draft' AND NEW.status = 'issued' THEN
            IF NOT EXISTS (SELECT 1 FROM aec_transmittal_items i WHERE i.transmittal_id = OLD.id) THEN
                RAISE EXCEPTION 'aec_transmittals: a transmittal with no documents cannot be issued'
                    USING ERRCODE = 'check_violation';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM aec_transmittal_recipients r WHERE r.transmittal_id = OLD.id) THEN
                RAISE EXCEPTION 'aec_transmittals: a transmittal with no recipients cannot be issued'
                    USING ERRCODE = 'check_violation';
            END IF;
        ELSIF OLD.status = 'issued' AND NEW.status = 'acknowledged' THEN
            SELECT count(*) INTO stuck
              FROM aec_transmittal_recipients r
             WHERE r.transmittal_id = OLD.id
               AND r.requires_acknowledgement
               AND r.acknowledged_at IS NULL;
            IF stuck > 0 THEN
                RAISE EXCEPTION 'aec_transmittals: % recipient(s) have not acknowledged receipt', stuck
                    USING ERRCODE = 'check_violation';
            END IF;
        ELSE
            RAISE EXCEPTION 'aec_transmittals: illegal status transition % -> %',
                OLD.status, NEW.status USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF OLD.status <> 'draft' THEN
        IF NEW.id <> OLD.id
           OR NEW.business_id <> OLD.business_id
           OR NEW.project_id <> OLD.project_id
           OR NEW.transmittal_number <> OLD.transmittal_number
           OR NEW.subject <> OLD.subject
           OR NEW.sender_party_id IS DISTINCT FROM OLD.sender_party_id
           OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
           OR NEW.purpose <> OLD.purpose
           OR NEW.comments <> OLD.comments THEN
            RAISE EXCEPTION 'aec_transmittals: an issued transmittal is a historical record'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_transmittals_guard
    BEFORE UPDATE OR DELETE ON aec_transmittals
    FOR EACH ROW EXECUTE FUNCTION aec_transmittal_guard();

-- ---------------------------------------------------------------------------
-- 10. The lines of a transmittal
-- ---------------------------------------------------------------------------
-- Same rule as 0196's BOQ lines: a line may only be written while its
-- transmittal is a draft.
--
-- The items and the recipients get one function each rather than a shared one
-- that branches on TG_TABLE_NAME. A shared function would have to name
-- `NEW.party_id` while it is also the trigger on `aec_transmittal_items`, which
-- has no such column — plpgsql resolves that reference against the attaching
-- table's row type, so the `AND` chain would raise `record "new" has no field
-- "party_id"` before it ever got to short-circuit.
CREATE OR REPLACE FUNCTION aec_transmittal_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    parent_status text;
BEGIN
    SELECT status INTO parent_status
      FROM aec_transmittals
     WHERE id = COALESCE(NEW.transmittal_id, OLD.transmittal_id);
    IF parent_status IS NULL THEN
        RAISE EXCEPTION 'aec_transmittals: transmittal does not exist'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF parent_status = 'draft' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    RAISE EXCEPTION 'aec_transmittals: % is % and its documents can no longer be changed',
        COALESCE(NEW.transmittal_id, OLD.transmittal_id), parent_status
        USING ERRCODE = 'check_violation';
END $$;

-- The recipients' own rule, with the acknowledgement exception: receipt happens
-- after issue by definition, so a recipient row of an *issued* transmittal may
-- still be stamped — and nothing else about it may change.
CREATE OR REPLACE FUNCTION aec_transmittal_recipient_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    parent_status text;
BEGIN
    SELECT status INTO parent_status
      FROM aec_transmittals
     WHERE id = COALESCE(NEW.transmittal_id, OLD.transmittal_id);
    IF parent_status IS NULL THEN
        RAISE EXCEPTION 'aec_transmittals: transmittal does not exist'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF parent_status = 'draft' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP = 'UPDATE'
       AND parent_status IN ('issued', 'acknowledged')
       AND NEW.business_id = OLD.business_id
       AND NEW.transmittal_id = OLD.transmittal_id
       AND NEW.party_id = OLD.party_id
       AND NEW.requires_acknowledgement = OLD.requires_acknowledgement
       AND NEW.note = OLD.note THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'aec_transmittals: % is % and its recipients can no longer be changed',
        COALESCE(NEW.transmittal_id, OLD.transmittal_id), parent_status
        USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER trg_aec_transmittal_items_guard
    BEFORE INSERT OR UPDATE OR DELETE ON aec_transmittal_items
    FOR EACH ROW EXECUTE FUNCTION aec_transmittal_line_guard();

CREATE TRIGGER trg_aec_transmittal_recipients_guard
    BEFORE INSERT OR UPDATE OR DELETE ON aec_transmittal_recipients
    FOR EACH ROW EXECUTE FUNCTION aec_transmittal_recipient_guard();

-- ---------------------------------------------------------------------------
-- 11. The line's snapshot of what it carries
-- ---------------------------------------------------------------------------
-- Written by the database from the revision, not posted by the caller: a client
-- cannot claim a transmittal carried revision C when it carried B. The line also
-- refuses a revision from another business, which the composite FK to the
-- transmittal half-checks and this trigger completes.
CREATE OR REPLACE FUNCTION aec_transmittal_item_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    revision record;
BEGIN
    SELECT r.business_id, r.revision_code, r.issue_purpose, d.document_number, d.title
      INTO revision
      FROM aec_document_revisions r
      JOIN aec_documents d ON d.id = r.document_id
     WHERE r.id = NEW.revision_id;

    IF revision IS NULL THEN
        RAISE EXCEPTION 'aec_transmittal_items: revision does not exist'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF revision.business_id <> NEW.business_id OR revision.business_id <> (
        SELECT business_id FROM aec_transmittals WHERE id = NEW.transmittal_id
    ) THEN
        RAISE EXCEPTION 'aec_transmittal_items: the revision belongs to another business'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    NEW.document_number := revision.document_number;
    NEW.document_title := revision.title;
    NEW.revision_code := revision.revision_code;
    NEW.issue_purpose := revision.issue_purpose;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_transmittal_items_snapshot
    BEFORE INSERT ON aec_transmittal_items
    FOR EACH ROW EXECUTE FUNCTION aec_transmittal_item_snapshot();

-- ---------------------------------------------------------------------------
-- 12. The references that cannot be composite foreign keys, tenant-checked
-- ---------------------------------------------------------------------------
-- Two shapes, both the same rule — a live record of the same business, or
-- nothing:
--
--   * a document's phase and task must belong to the document's own project;
--   * a transmittal's sender and a recipient must be live parties of the same
--     business (and, as 0194 does for participants, not a merged-away record —
--     otherwise a later merge would have to rewrite history).
CREATE OR REPLACE FUNCTION aec_assert_document_links_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.phase_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM workspace_project_phases ph
                        WHERE ph.id = NEW.phase_id AND ph.project_id = NEW.project_id) THEN
        RAISE EXCEPTION 'aec_documents.phase_id must belong to the document''s own project'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.task_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ai_project_tasks t
                        WHERE t.id = NEW.task_id AND t.project_id = NEW.project_id) THEN
        RAISE EXCEPTION 'aec_documents.task_id must belong to the document''s own project'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_documents_links
    BEFORE INSERT OR UPDATE OF project_id, phase_id, task_id ON aec_documents
    FOR EACH ROW EXECUTE FUNCTION aec_assert_document_links_owned();

CREATE OR REPLACE FUNCTION aec_assert_transmittal_party_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.party_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM parties
                        WHERE id = NEW.party_id
                          AND business_id = NEW.business_id
                          AND merged_into_id IS NULL) THEN
        RAISE EXCEPTION 'aec_transmittal_recipients.party_id must reference a live party of the same business'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_transmittal_recipients_party
    BEFORE INSERT OR UPDATE OF business_id, party_id ON aec_transmittal_recipients
    FOR EACH ROW EXECUTE FUNCTION aec_assert_transmittal_party_owned();

CREATE OR REPLACE FUNCTION aec_assert_transmittal_sender_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.sender_party_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM parties
                        WHERE id = NEW.sender_party_id
                          AND business_id = NEW.business_id
                          AND merged_into_id IS NULL) THEN
        RAISE EXCEPTION 'aec_transmittals.sender_party_id must reference a live party of the same business'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_aec_transmittals_sender
    BEFORE INSERT OR UPDATE OF business_id, sender_party_id ON aec_transmittals
    FOR EACH ROW EXECUTE FUNCTION aec_assert_transmittal_sender_owned();

-- ---------------------------------------------------------------------------
-- 13. The activity feed carries the document-control events
-- ---------------------------------------------------------------------------
-- Additive and idempotent, as in 0196: the new list is a superset of the old.
ALTER TABLE workspace_activity DROP CONSTRAINT IF EXISTS workspace_activity_subject_type_check;
ALTER TABLE workspace_activity ADD CONSTRAINT workspace_activity_subject_type_check
    CHECK (subject_type IN (
        'project', 'task', 'document', 'contract', 'approval', 'member', 'event',
        'estimate', 'document_revision', 'transmittal'
    ));

-- ---------------------------------------------------------------------------
-- 14. §22's "Latest Drawing Revisions" widget
-- ---------------------------------------------------------------------------
-- The widget could not be offered until the register existed: §22's rule is
-- that a recommended widget must be answerable from data the product holds.
-- Idempotent per (industry, name), like 0195.
INSERT INTO ai_widget_templates
  (name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height, created_by)
SELECT v.name, v.description, v.industry, v.source_app, v.required_permissions, v.prompt, v.output_format, v.default_width, v.default_height, 'system'
  FROM (VALUES
    (
      'آخرین بازنگری نقشه‌ها',
      'شماره، عنوان و وضعیت آخرین بازنگری هر نقشهٔ پروژه',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.view']::text[],
      'فهرست نقشه‌های پروژه‌های فعال را با آخرین بازنگری هرکدام بنویس: شمارهٔ سند، عنوان، کد بازنگری، وضعیت (پیش‌نویس/صادرشده/منسوخ) و تاریخ آن. نقشه‌هایی که بازنگری تازه‌ای منتظر صدور دارند را جدا کن.',
      'bullets',
      2,
      1
    )
  ) AS v(name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height)
 WHERE NOT EXISTS (
   SELECT 1 FROM ai_widget_templates t
    WHERE t.industry = v.industry AND t.name = v.name
 );
