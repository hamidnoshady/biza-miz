-- «سند دستی» hardening (issue #823) — a draft's decision has to outlive the
-- draft.
--
-- The workflow this closes: somebody proposes a manual journal, somebody with
-- `ledger.approve` approves or rejects it. Before this migration the only
-- trace of the *proposal* was `journal_entry_drafts.created_by/created_at`,
-- and approving deleted the draft row immediately afterwards — so the posted
-- entry named only the approver. Rejection was a bare DELETE: no actor, no
-- time, no reason. An accountant asking «چه کسی این سند را پیشنهاد داد و چه
-- کسی آن را رد کرد» had nothing to read.
--
-- Four things are added, each for a different reason:
--
--  1. `journal_entry_drafts.proposed_by/proposed_at` — the proposal, kept in
--     its own columns rather than read through `created_by/created_at`. The
--     two mean different things (`created_*` is the row's audit stamp,
--     `proposed_*` is the accounting act) and the posted entry copies the
--     latter, so they are never quietly conflated. Backfilled from the
--     existing columns, so an open review queue keeps its history.
--  2. `journal_entry_draft_rejections` — the rejection, in its own table with
--     NO foreign key to `journal_entry_drafts`. That is deliberate: a
--     rejected draft is deleted, and `ON DELETE CASCADE` would take the
--     history with it, which is the exact loss this fixes. The draft's own
--     facts (memo, date, branch, proposer) are copied onto the row so asking
--     «what was rejected in March» does not need a join to a deleted table.
--  3. `journal_entries.proposed_by/proposed_at/approved_by/approved_at/
--     draft_id` — the decision, on the row that lives for ever. `draft_id`
--     also has no foreign key, for the same cascade reason: it is a
--     provenance reference to a row that no longer exists, not a relationship
--     the database must enforce.
--
--  4. `journal_entry_drafts.idempotency_key`, the same story from the request
--     side: a retried «ثبت پیش‌نویس» (a flaky connection, a double tap, a
--     reconnecting client) created two drafts that could then be approved
--     twice. The unique index is partial, so the drafts that predate it — and
--     the callers that never send a key — are unaffected.
--
-- It also backfills `entry_date` on the drafts already open. Blank used to be
-- stored as NULL and resolved by `CURRENT_DATE` at *approval*, in the database
-- server's timezone; the service now freezes a branch-local date when the
-- draft is written, and the backfill brings the rows already in a queue
-- (whose approval would otherwise post them today) into line with it.

ALTER TABLE journal_entry_drafts
    ADD COLUMN proposed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN proposed_at timestamptz,
    ADD COLUMN idempotency_key text;

UPDATE journal_entry_drafts
   SET proposed_by = created_by,
       proposed_at = created_at;

-- «امروز» for the drafts already open. Every draft written after this
-- migration has a concrete `entry_date` (the service resolves it at creation),
-- but the rows already sitting in a review queue were written when blank meant
-- NULL, and approving one of those would post it under the *database server's*
-- date. Backfilling from `created_at` in the draft's own branch is the closest
-- honest answer to the date the person meant, and it is the same
-- `app_business_date` rule the service now applies going forward.
UPDATE journal_entry_drafts d
   SET entry_date = app_business_date(
                      d.created_at,
                      coalesce(l.timezone, 'Asia/Tehran'),
                      l.business_day_start_minutes
                    )
  FROM locations l
 WHERE d.entry_date IS NULL
   AND l.id = d.location_id;

-- A draft whose branch is gone cannot be resolved branch-by-branch; the
-- business-wide fallback keeps it a real date rather than a NULL the approval
-- path would have to guess at.
UPDATE journal_entry_drafts d
   SET entry_date = (d.created_at AT TIME ZONE 'Asia/Tehran')::date
 WHERE d.entry_date IS NULL;

-- One draft per key per business. Partial: NULL keys (every caller that does
-- not opt in) are not part of the uniqueness, which is what keeps this
-- additive rather than a behaviour change.
CREATE UNIQUE INDEX idx_journal_entry_drafts_idempotency
    ON journal_entry_drafts (business_id, idempotency_key)
 WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The rejection ledger
-- ---------------------------------------------------------------------------
CREATE TABLE journal_entry_draft_rejections (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Deliberately NOT a foreign key: the draft row is deleted by the very
    -- rejection that writes this one.
    draft_id         uuid NOT NULL,
    location_id      uuid REFERENCES locations(id) ON DELETE SET NULL,
    memo             text NOT NULL DEFAULT '',
    entry_date       date,
    proposed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    proposed_at      timestamptz,
    rejected_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    rejected_at      timestamptz NOT NULL DEFAULT now(),
    rejection_reason text
);
CREATE INDEX idx_journal_entry_draft_rejections_business
    ON journal_entry_draft_rejections (business_id, rejected_at DESC);
CREATE INDEX idx_journal_entry_draft_rejections_draft
    ON journal_entry_draft_rejections (draft_id);

ALTER TABLE journal_entry_draft_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entry_draft_rejections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journal_entry_draft_rejections FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- The decision, on the row that survives approval
-- ---------------------------------------------------------------------------
ALTER TABLE journal_entries
    ADD COLUMN proposed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN proposed_at timestamptz,
    ADD COLUMN approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN approved_at timestamptz,
    ADD COLUMN draft_id    uuid;

-- Provenance only — the draft row is gone by the time this is written, so
-- there is nothing to reference.
CREATE INDEX idx_journal_entries_draft_id
    ON journal_entries (draft_id) WHERE draft_id IS NOT NULL;
