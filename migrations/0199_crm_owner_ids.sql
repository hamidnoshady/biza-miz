-- CRM ownership: backfill the stable member ids that migration 0157 added but
-- never filled.
--
-- ## Why this migration exists
--
-- 0157 added `crm_deals.owner_user_id`, `crm_leads.owner_user_id`,
-- `crm_activities.assignee_user_id`, `crm_cases.assignee_user_id` and
-- `parties.crm_owner_user_id` so the CRM could finally *identify* who owns a
-- relationship instead of storing a name. It deliberately left the text columns
-- beside them as display snapshots — but it did not fill the ids, because
-- matching a free-text name to a member is a decision, not a schema change.
--
-- Until the ids are filled, every "my customers", "assigned to me" and
-- reassignment feature is unavailable to the businesses that already have data,
-- which is exactly the audience that needs it. So this migration performs the
-- backfill, under two rules that make it safe to run on production data:
--
--   1. **Only an unambiguous match is written.** A name that matches two
--      members (two people called «مریم») is left NULL. Guessing would attach
--      one person's customer list to another's, and the CRM's own rule is that
--      identity is never guessed — the same reason a duplicate customer is
--      reported rather than resolved automatically.
--   2. **Nothing is deleted or rewritten.** The text column keeps its value; it
--      is the snapshot the audit trail and the pre-0157 screens read. This
--      migration only ever fills NULL ids.
--
-- Names are compared on `btrim(lower(full_name))`: trailing whitespace and case
-- are noise, so they are ignored. Arabic letterform variants (`ي` for `ی`, `ك`
-- for `ک`) are **not** folded, deliberately — a name that differs by letterform
-- is not certainly the same person, and a wrong owner is worse than an
-- unassigned row, which stays visible as «تعیین مسئول».
--
-- Idempotent: every statement is `WHERE ... IS NULL`, so a re-run (or a run on
-- a database that already has ids) changes nothing.

-- ---------------------------------------------------------------------------
-- Deals: `owner_user` (text) → `owner_user_id`
-- ---------------------------------------------------------------------------
UPDATE crm_deals d
   SET owner_user_id = matched.id
  FROM (
    SELECT u.business_id, btrim(lower(u.full_name)) AS key, min(u.id::text)::uuid AS id
      FROM users u
     WHERE btrim(coalesce(u.full_name, '')) <> ''
     GROUP BY u.business_id, btrim(lower(u.full_name))
    HAVING count(*) = 1
  ) AS matched
 WHERE d.business_id = matched.business_id
   AND btrim(coalesce(d.owner_user, '')) <> ''
   AND btrim(lower(d.owner_user)) = matched.key
   AND d.owner_user_id IS NULL;

-- ---------------------------------------------------------------------------
-- Leads: `owner_name` (text) → `owner_user_id`
-- ---------------------------------------------------------------------------
UPDATE crm_leads l
   SET owner_user_id = matched.id
  FROM (
    SELECT u.business_id, btrim(lower(u.full_name)) AS key, min(u.id::text)::uuid AS id
      FROM users u
     WHERE btrim(coalesce(u.full_name, '')) <> ''
     GROUP BY u.business_id, btrim(lower(u.full_name))
    HAVING count(*) = 1
  ) AS matched
 WHERE l.business_id = matched.business_id
   AND btrim(coalesce(l.owner_name, '')) <> ''
   AND btrim(lower(l.owner_name)) = matched.key
   AND l.owner_user_id IS NULL;

-- ---------------------------------------------------------------------------
-- Activities and cases: `assigned_to` (text) → `assignee_user_id`
-- ---------------------------------------------------------------------------
-- `assigned_to` on both tables is a display name, matching the `created_by`
-- convention of the tables they were created in. It is not an id, and it is not
-- dropped: the activity list and the case list still render it.
UPDATE crm_activities a
   SET assignee_user_id = matched.id
  FROM (
    SELECT u.business_id, btrim(lower(u.full_name)) AS key, min(u.id::text)::uuid AS id
      FROM users u
     WHERE btrim(coalesce(u.full_name, '')) <> ''
     GROUP BY u.business_id, btrim(lower(u.full_name))
    HAVING count(*) = 1
  ) AS matched
 WHERE a.business_id = matched.business_id
   AND btrim(coalesce(a.assigned_to, '')) <> ''
   AND btrim(lower(a.assigned_to)) = matched.key
   AND a.assignee_user_id IS NULL;

UPDATE crm_cases c
   SET assignee_user_id = matched.id
  FROM (
    SELECT u.business_id, btrim(lower(u.full_name)) AS key, min(u.id::text)::uuid AS id
      FROM users u
     WHERE btrim(coalesce(u.full_name, '')) <> ''
     GROUP BY u.business_id, btrim(lower(u.full_name))
    HAVING count(*) = 1
  ) AS matched
 WHERE c.business_id = matched.business_id
   AND btrim(coalesce(c.assigned_to, '')) <> ''
   AND btrim(lower(c.assigned_to)) = matched.key
   AND c.assignee_user_id IS NULL;

-- ---------------------------------------------------------------------------
-- Parties: the CRM's owner came from the shared party editor, which wrote no
-- name at all — so there is nothing to match. Left explicit so a reader does
-- not wonder why this table has no UPDATE here: `parties` predates the CRM's
-- ownership fields, and its owner is set going forward (`crm-ownership.ts`).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Reassignment needs to answer "what is stuck with somebody who has left?"
-- quickly, and only a partial index keeps that from being a full scan of every
-- CRM row per tenant.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_crm_activities_inactive_assignee
    ON crm_activities (business_id, assignee_user_id)
 WHERE completed_at IS NULL AND assignee_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_cases_inactive_assignee
    ON crm_cases (business_id, assignee_user_id)
 WHERE closed_at IS NULL AND assignee_user_id IS NOT NULL;
