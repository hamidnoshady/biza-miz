-- ============================================================================
-- 0212_saved_report_versions.sql — issue #819, Report Builder Step 8
--
-- A saved report stored its query config, its visualization (inside the config
-- since #819) and its name. The builder's target UX also asks for an optional
-- description and a version, so a report can say what it is for and whoever
-- opens it can tell whether the definition has been edited since they last ran
-- it — the two things a shared saved report needs and a per-name list cannot
-- express.
--
-- `version` starts at the definition's first save (1) and is incremented by
-- `updateSavedReport` on every edit, including a rename: the audit question is
-- "has this definition changed since I looked at it", not only "did its SQL
-- change". Standard (seeded) reports are re-seeded from code with an upsert
-- that deliberately leaves both columns alone: they are not the member's rows
-- to version, and `ensureStandardSavedReports` rewrites them from the report
-- catalogue on every deploy.
-- ============================================================================

ALTER TABLE saved_reports
    ADD COLUMN description text,
    ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);
