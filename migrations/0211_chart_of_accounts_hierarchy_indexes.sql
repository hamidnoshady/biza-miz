-- ---------------------------------------------------------------------------
-- Chart-of-accounts hierarchy: the two indexes the issue #824 hardening needs.
-- ---------------------------------------------------------------------------
-- 1. `accounts.parent_id` had no index. The column is a foreign key, and
--    PostgreSQL deliberately does **not** index a referencing column, so every
--    "who are this account's children?" question was a sequential scan of the
--    whole table. That was already true of the `has_children` flag on the
--    chart screen (`EXISTS (SELECT 1 FROM accounts c WHERE c.parent_id = a.id)`),
--    and issue #824 makes it worse by walking descendants one level at a time —
--    `fetchDescendants`, the level cascade on reparent, and the archive guard
--    that must see active grandchildren beneath archived intermediates. Each of
--    those is one query per node, so the missing index turned a bounded walk
--    into N sequential scans.
--
-- 2. `journal_entry_draft_lines.account_id` had no index either (only
--    `draft_id`). Issue #824 added `hasDraftPostings` to the chart listing —
--    one `EXISTS (… WHERE dl.account_id = a.id)` per account — plus the same
--    check in `deleteAccount`. `journal_lines` has had `idx_journal_lines_account`
--    since Phase 7 for exactly this reason; the draft table simply never got
--    one, because nothing queried it by account until now.
--
-- Both are plain, non-unique indexes: they change no data and no constraint,
-- and creating them cannot fail on an existing chart (unlike a unique index,
-- which would have to contend with a duplicate a badly-ordered import could
-- have left behind).
--
-- CONCURRENTLY is deliberately not used: migrations run inside the app's own
-- migration runner in a transaction, and the chart/accounts tables are small
-- relative to the posting tables (one row per account, not per transaction) —
-- the brief lock is not worth the loss of transactional migration semantics.

CREATE INDEX IF NOT EXISTS idx_accounts_parent
    ON accounts (parent_id);

CREATE INDEX IF NOT EXISTS idx_journal_entry_draft_lines_account
    ON journal_entry_draft_lines (account_id);
