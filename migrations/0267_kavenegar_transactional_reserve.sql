-- Issue #902 §3 — a slice of the master's credit that marketing can never spend.
--
-- The funding floor added in `0259` protects one thing: automatic top-ups never
-- take the master below `managed_funding_master_floor_rial`. That is the fleet's
-- own guard, and it is not what DoD #9 asks for. DoD #9 says a login OTP must
-- keep working when "tenant marketing credit is exhausted" and when "every child
-- is capped". A child capped by `managed_funding_child_cap_rial` simply stops
-- being funded, and once the master drifts down to the floor, automation stops
-- funding *anyone* — so the message that stops flowing is the transactional one
-- a customer or an employee is waiting for, while a marketing campaign that was
-- already funded keeps sending.
--
-- The distinction the floor cannot make is *why* a message is being sent. This
-- migration adds the one number that can: the reserve is a slice of the master's
-- credit, and a child whose spend is transactional may be funded out of it,
-- while a child whose spend is marketing may not. Nothing is reserved in the
-- provider's ledger — the provider has no such concept — so the reserve is
-- enforced here, on our side of the call, by `planFunding`:
--
--   * `managed_funding_transactional_reserve_rial` — how much of the master's
--     credit is held back for transactional traffic. 0 (the default) means no
--     reserve, i.e. today's behaviour exactly; nothing turns itself on.
--   * `managed_funding_purpose` — how an operator classifies this fleet's spend,
--     because the platform cannot know that a given business sends order-ready
--     messages and login codes rather than campaigns. `marketing` is the safe
--     default: it may not touch the reserve, so adding the reserve can only ever
--     protect capacity, never silently let more money out.
--
-- The rule, in `planFunding`: spendable = master − floor − reserve is what
-- *marketing* funding may use; transactional funding may use
-- master − floor, and its own transfers still count against the fleet cap.

ALTER TABLE platform_sms_config
    ADD COLUMN managed_funding_transactional_reserve_rial bigint NOT NULL DEFAULT 0
        CHECK (managed_funding_transactional_reserve_rial >= 0),
    ADD COLUMN managed_funding_purpose text NOT NULL DEFAULT 'marketing'
        CHECK (managed_funding_purpose IN ('marketing', 'transactional'));

COMMENT ON COLUMN platform_sms_config.managed_funding_transactional_reserve_rial IS
    'Issue #902 #3/DoD #9: credit above the master floor that only transactional funding may spend. 0 = no reserve.';
COMMENT ON COLUMN platform_sms_config.managed_funding_purpose IS
    'How this fleet''s provider spend is classified for the reserve: marketing (default, cannot touch it) or transactional.';

-- The alert ledger's closed vocabulary has to carry the new block reason, or a
-- fleet held back by the reserve would raise nothing at all (the previous CHECK
-- would reject the insert and the pass would report an unhandled failure).
ALTER TABLE kavenegar_service_alerts
    DROP CONSTRAINT kavenegar_service_alerts_kind_check,
    ADD CONSTRAINT kavenegar_service_alerts_kind_check CHECK (kind IN (
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
        'tariff_missing',
        'transactional_reserve_held'
    ));
