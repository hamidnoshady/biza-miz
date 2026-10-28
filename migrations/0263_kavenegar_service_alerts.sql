-- Issue #902 §3 — Superadmin alerting for the managed SMS service.
--
-- The funding and reconciliation passes already *decide* correctly; what they
-- could not do is tell a human. Drift was a `console.error` line, a failed
-- transfer was a row nobody watched, and "the master account is nearly out of
-- credit" was invisible until a child stopped sending. The issue is explicit
-- (§3, last bullet): "Alert Superadmin for low master credit, child
-- discrepancies, suspended accounts, failed transfers."
--
-- This table is that alert store, and it is deliberately an *attention ledger*
-- rather than a log:
--
--   * one row per condition, not per occurrence — `occurrences` and
--     `last_seen_at` move while the condition persists, so a tick that fires
--     every 15 minutes cannot bury the console in duplicates;
--   * `resolved_at` is set by the pass that observes the condition is gone, so
--     the table answers "what needs a human right now" without a separate
--     cleanup story;
--   * acknowledgement is an operator act and is recorded with who and when,
--     which is the difference between "we know" and "we dealt with it".
--
-- Nothing here is tenant data. An alert names a business at most as the subject
-- of an internal condition (a child that is out of credit), which is platform
-- operational information; the table is platform-only under FORCE RLS so no
-- tenant connection can read it, and no alert text is ever returned by a tenant
-- API.

CREATE TABLE kavenegar_service_alerts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The condition. A closed set, because the console's copy, severity and
    -- resolution rule are all keyed on it — a free-text kind would be a log.
    kind           text NOT NULL CHECK (kind IN (
                       'master_credit_low',
                       'master_balance_unknown',
                       'fleet_cap_reached',
                       'child_cap_reached',
                       'daily_cap_reached',
                       'unresolved_transfer',
                       'funding_failed',
                       'reconciliation_drift',
                       'reconciliation_incomplete',
                       'account_suspended',
                       'provisioning_failed',
                       'tariff_missing'
                   )),
    severity       text NOT NULL DEFAULT 'warning'
                       CHECK (severity IN ('critical', 'warning', 'info')),
    -- The SUBJECT of the condition, when it is about one child. NULL for
    -- fleet-wide conditions such as the master account running low.
    --
    -- Deliberately not named `business_id`: the tenancy sweep treats that name
    -- as ownership and requires a tenant policy for it, while this column is a
    -- targeting key on a platform-only alert ("this child is out of credit").
    -- The row belongs to the platform, not to the business it names — which is
    -- also why business B must not be able to read an alert about business A.
    subject_business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
    account_id     uuid REFERENCES kavenegar_business_accounts(id) ON DELETE CASCADE,
    -- A discriminator for conditions that can repeat for one subject (a
    -- transfer id, a reconciliation window). Empty string when the condition is
    -- the subject itself.
    subject_key    text NOT NULL DEFAULT '',
    -- Extra internal evidence: the blocked reason, the delta, the amounts. This
    -- is the Superadmin's diagnostic context and is never serialised to a
    -- tenant, so it may name provider amounts.
    detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurrences    integer NOT NULL DEFAULT 1 CHECK (occurrences > 0),
    first_seen_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now(),
    acknowledged_at timestamptz,
    acknowledged_by uuid,
    acknowledgement_note text,
    resolved_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One OPEN row per (kind, subject, discriminator). A resolved row no longer
-- participates, so the same condition can be raised again later without
-- colliding with its own history.
CREATE UNIQUE INDEX kavenegar_service_alerts_open_unique
    ON kavenegar_service_alerts (
        kind,
        coalesce(subject_business_id, '00000000-0000-0000-0000-000000000000'::uuid),
        subject_key
    )
    WHERE resolved_at IS NULL;

CREATE INDEX idx_kavenegar_service_alerts_open
    ON kavenegar_service_alerts (resolved_at, last_seen_at DESC);

ALTER TABLE kavenegar_service_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kavenegar_service_alerts FORCE ROW LEVEL SECURITY;
-- No tenant policy: "the platform's master account is low on credit" is not a
-- business's business, and an alert that names one business must not be
-- readable by another. The console reads it under the documented bypass.
CREATE POLICY platform_only ON kavenegar_service_alerts FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

COMMENT ON TABLE kavenegar_service_alerts IS
    'Issue #902 §3: Superadmin attention ledger for the managed SMS service — low master credit, cap pressure, failed/unknown transfers, drift, suspended children. One open row per condition.';
COMMENT ON COLUMN kavenegar_service_alerts.subject_business_id IS
    'Issue #902 §3: the business an alert is ABOUT (a child out of credit), never the owner of the row.';
COMMENT ON COLUMN kavenegar_service_alerts.detail IS
    'Internal diagnostics (blocked reason, amounts, delta). Platform-only; never returned to a tenant.';
