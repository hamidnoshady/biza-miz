-- Issue #902 §5 — the lookup-template lifecycle, completed.
--
-- `0259` introduced `kavenegar_lookup_templates` with a provider-neutral state
-- machine and an immutable derived provider name. Two things were still
-- missing for the lifecycle the issue describes ("updating a master template
-- must support safe versioned rollout and reapproval without breaking active
-- sends"):
--
--   * **a way to tell whether the provider already has the CURRENT text.**
--     `state` alone cannot: a rejected row and an untouched draft look the same
--     to a submitter, so a resubmit could call `addtemplate` again and rely on
--     the provider's duplicate-name refusal to paper over it.
--   * **a way to revise an APPROVED template without stopping its sends.**
--     Overwriting the live row would move it out of `approved` the moment a
--     tenant started editing, silently disabling automation that is working
--     today. A revision of a live template is therefore a new row that
--     supersedes the old one: the old row keeps serving sends until the new one
--     is approved.
--
-- Nothing here is a balance, a price or a credential. The table stays
-- tenant-scoped (a business reads its own catalog; only services write it).

ALTER TABLE kavenegar_lookup_templates
    -- How many in-place edits this row has taken. Monotonic, for the audit view.
    ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0,
    -- Exactly what the provider was last asked to review. Null means "never
    -- submitted", which is why a draft and a rejected row are distinguishable
    -- without asking the provider.
    ADD COLUMN IF NOT EXISTS submitted_title text,
    ADD COLUMN IF NOT EXISTS submitted_body text,
    -- Set on a NEW row that replaces an approved one. The predecessor keeps its
    -- `approved` state (and therefore keeps serving triggers) until this row is
    -- approved in turn.
    ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES kavenegar_lookup_templates(id) ON DELETE SET NULL,
    -- Retired at the provider. Kept as a row so history and the derived name
    -- remain resolvable (the name must never be reused for different content).
    ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Backfill: a row that is already submitted/approved/decided was reviewed with
-- the text it currently holds. This keeps `needsProviderUpdate` false for
-- existing rows, so the first sync after the upgrade does not resubmit anything.
UPDATE kavenegar_lookup_templates
   SET submitted_title = title,
       submitted_body = body
 WHERE state IN ('submitted', 'approved', 'rejected')
   AND submitted_body IS NULL;

-- The console lists drift-first by state; a superseded row is never the one to
-- act on, so the lookup filters on the live ones.
CREATE INDEX IF NOT EXISTS idx_kavenegar_lookup_templates_live
    ON kavenegar_lookup_templates (business_id, state)
    WHERE archived_at IS NULL;

COMMENT ON COLUMN kavenegar_lookup_templates.supersedes_id IS
    'Issue #902: versioned reapproval. A new row replaces an approved template; the old row keeps sending until the new one is approved.';
COMMENT ON COLUMN kavenegar_lookup_templates.submitted_body IS
    'The text last handed to the provider for review — the only reliable way to know a resubmit needs updatetemplate instead of addtemplate.';

-- RLS is unchanged: the table already carries `tenant_isolation` (FORCE) from
-- `0259`, and these columns inherit it.
